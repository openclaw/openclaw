import fs from "node:fs/promises";
import path from "node:path";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  loadAuthProfileStoreForSecretsRuntime,
} from "openclaw/plugin-sdk/agent-runtime";
import type { MigrationProviderContext as Context } from "openclaw/plugin-sdk/plugin-entry";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawStateDatabaseAsync,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
import {
  resolvePreferredOpenClawTmpDir,
  tempWorkspace,
  type TempWorkspace,
} from "openclaw/plugin-sdk/temp-path";
import { afterEach, beforeEach, expect, vi } from "vitest";
import { defaultCodexAppInventoryCache } from "../app-server/app-inventory-cache.js";
import type { CodexAppServerCloseResult } from "../app-server/transport.js";

const closeCredentialReader = vi.hoisted(() => vi.fn<() => Promise<CodexAppServerCloseResult>>());
const nativeCredentialReaderStart = vi.hoisted(() => vi.fn());
const appServerRequest = vi.hoisted(() => vi.fn());
const sourceAppServerClientScope = vi.hoisted(() => vi.fn());
const credentialStorage = vi.hoisted(() => ({
  mode: "file",
  requiredMode: undefined as string | undefined,
  accountType: "apiKey",
  accountReadFails: false,
}));
export {
  closeCredentialReader,
  nativeCredentialReaderStart,
  appServerRequest,
  sourceAppServerClientScope,
  credentialStorage,
};

vi.mock("../app-server/managed-binary.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../app-server/managed-binary.js")>()),
  resolveManagedCodexPackageEntrypoint: () => "/fixture/codex.js",
  resolveManagedCodexNativeCommand: () => "/fixture/codex",
}));

vi.mock("../app-server/client.js", () => ({
  CodexAppServerClient: {
    async start(options: { env: { CODEX_HOME: string } }) {
      // Native startup loads the selected credential store before accepting requests.
      nativeCredentialReaderStart(credentialStorage.requiredMode ?? credentialStorage.mode);
      return {
        initialize: async () => undefined,
        getRuntimeIdentity: () => ({ codexHome: options.env.CODEX_HOME }),
        getModelCatalogRevision: () => 0,
        getCloseError: () => undefined,
        close: () => undefined,
        closeAndWait: closeCredentialReader,
        async request(method: string) {
          if (method === "account/read") {
            if (credentialStorage.accountReadFails) {
              throw new Error("Account lookup unavailable");
            }
            return { account: { type: credentialStorage.accountType }, requiresOpenaiAuth: true };
          }
          if (method === "config/read") {
            return { config: { cli_auth_credentials_store: credentialStorage.mode } };
          }
          if (method === "configRequirements/read") {
            return {
              requirements: credentialStorage.requiredMode
                ? { cli_auth_credentials_store: credentialStorage.requiredMode }
                : null,
            };
          }
          throw new Error(`Unexpected credential request: ${method}`);
        },
      };
    },
  },
}));

vi.mock("../app-server/request.js", () => ({
  requestCodexAppServerJson: appServerRequest,
  withCodexAppServerJsonClient: sourceAppServerClientScope,
}));

const tempWorkspaces: TempWorkspace[] = [];

const noop = () => {};
const logger = { info: noop, warn: noop, error: noop, debug: noop };

export async function writeFile(filePath: string, content = ""): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf8");
}

export function makeContext({
  workspaceDir,
  verifyPluginApps,
  ...params
}: Pick<Context, "source" | "stateDir"> &
  Partial<Context> & {
    workspaceDir: string;
    verifyPluginApps?: boolean;
  }): Context {
  return {
    ...params,
    config: params.config ?? { agents: { defaults: { workspace: workspaceDir } } },
    providerOptions:
      params.providerOptions ?? (verifyPluginApps ? { verifyPluginApps: true } : undefined),
    logger,
  };
}

export function findItem(items: readonly { id?: string }[], id: string) {
  const item = items.find((entry) => entry.id === id);
  expect(item, `Expected migration item ${id}`).toBeDefined();
  return item as Record<string, unknown>;
}

export function expectRecordFields(record: unknown, expected: Record<string, unknown>) {
  expect(record).toEqual(expect.objectContaining(expected));
  return record as Record<string, unknown>;
}

export function fakeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.signature`;
}

export function targetAgentDir(fixture: { stateDir: string }, agentId = "main"): string {
  return path.join(fixture.stateDir, "agents", agentId, "agent");
}

export function loadTargetAuthStore(fixture: { stateDir: string }, agentId = "main") {
  return loadAuthProfileStoreForSecretsRuntime(targetAgentDir(fixture, agentId));
}

export async function createCodexFixture() {
  const workspace = await tempWorkspace({
    rootDir: resolvePreferredOpenClawTmpDir(),
    prefix: "openclaw-migrate-codex-",
  });
  tempWorkspaces.push(workspace);
  const root = workspace.dir;
  const homeDir = path.join(root, "home");
  const codexHome = path.join(root, ".codex");
  const stateDir = path.join(root, "state");
  const workspaceDir = path.join(root, "workspace");
  vi.stubEnv("HOME", homeDir);
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  vi.stubEnv("OPENCLAW_AGENT_DIR", "");
  await writeFile(path.join(homeDir, ".agents", "skills", "personal-style", "SKILL.md"));
  const files = {
    "skills/tweet-helper/SKILL.md": "# Tweet helper\n",
    "skills/.system/system-skill/SKILL.md": "",
    "plugins/cache/openai-primary-runtime/documents/1.0.0/.codex-plugin/plugin.json":
      '{"name":"documents"}',
    "config.toml": 'model = "gpt-5.5"\n',
    "hooks/hooks.json": "{}\n",
  };
  for (const [file, content] of Object.entries(files)) {
    await writeFile(path.join(codexHome, file), content);
  }
  return { root, homeDir, codexHome, stateDir, workspaceDir };
}

export function createConfigRuntime(
  configState: Context["config"],
  writeError?: Error,
): Context["runtime"] {
  type Config = NonNullable<Context["runtime"]>["config"];
  const config: Pick<Config, "current" | "mutateConfigFile"> = {
    current: () => configState,
    mutateConfigFile: async (params) => {
      if (writeError) {
        throw writeError;
      }
      const result = await params.mutate(configState, {
        snapshot: {} as never,
        previousHash: null,
      });
      return {
        path: "/tmp/openclaw.json",
        previousHash: null,
        persistedHash: "test-persisted-hash",
        snapshot: {} as never,
        nextConfig: configState,
        afterWrite: { mode: "auto" },
        followUp: { mode: "auto", requiresRestart: false },
        result,
      };
    },
  };
  return { config } as unknown as Context["runtime"];
}

type Request = (params: { method: string; requestParams?: unknown }) => Promise<unknown>;

beforeEach(() => {
  closeCredentialReader.mockResolvedValue({ exited: true, cleanup: "closed" });
  credentialStorage.mode = "file";
  credentialStorage.requiredMode = undefined;
  credentialStorage.accountType = "apiKey";
  credentialStorage.accountReadFails = false;
  appServerRequest.mockRejectedValue(new Error("codex app-server unavailable"));
  sourceAppServerClientScope.mockImplementation(
    async (options: Record<string, unknown>, run: (request: Request) => Promise<unknown>) =>
      await run(async (request) => await appServerRequest({ ...options, ...request })),
  );
});

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  clearRuntimeAuthProfileStoreSnapshots();
  closeCredentialReader.mockReset();
  nativeCredentialReaderStart.mockReset();
  appServerRequest.mockReset();
  sourceAppServerClientScope.mockReset();
  defaultCodexAppInventoryCache.clear();
  for (const workspace of tempWorkspaces) {
    await closeOpenClawAgentDatabasesAsync(workspace.dir);
  }
  await closeOpenClawStateDatabaseAsync();
  await Promise.all(tempWorkspaces.splice(0).map((workspace) => workspace.cleanup()));
});
