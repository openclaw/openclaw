import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type * as CodexHarness from "../../extensions/codex/harness.js";
import type * as CodexTestApi from "../../extensions/codex/test-api.js";
import { awaitGateBeforeSettlement } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/config.js";
import { createEmptyPluginMetadataSnapshot } from "../plugins/plugin-metadata-empty.test-support.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { loadBundledPluginFacade } from "../test-utils/bundled-plugin-public-surface.js";
import type { AuthProfileStore } from "./auth-profiles/types.js";
import type * as RuntimeModel from "./embedded-agent-runner/model.js";
import type * as HarnessPlugin from "./harness/runtime-plugin.js";
import type * as HarnessSelection from "./harness/selection-decision.js";
import type { AgentHarness } from "./harness/types.js";
import { runIsolatedCompletion } from "./isolated-completion.js";
import type * as ModelAuth from "./model-auth.js";
import type * as PreparedRuntime from "./prepared-model-runtime.js";

const mocks = vi.hoisted(() => ({
  acquire: vi.fn(),
  resolveModelAsync: vi.fn(),
  ensureAuthProfileStore: vi.fn(),
  selection: vi.fn(),
}));
vi.mock("./prepared-model-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof PreparedRuntime>()),
  acquireAgentRunPreparedModelRuntime: mocks.acquire,
}));
vi.mock("./embedded-agent-runner/model.js", async (importOriginal) => ({
  ...(await importOriginal<typeof RuntimeModel>()),
  resolveModelAsync: mocks.resolveModelAsync,
}));
vi.mock("./model-auth.js", async (importOriginal) => ({
  ...(await importOriginal<typeof ModelAuth>()),
  ensureAuthProfileStore: mocks.ensureAuthProfileStore,
}));
vi.mock("./harness/selection-decision.js", async (importOriginal) => ({
  ...(await importOriginal<typeof HarnessSelection>()),
  resolveAgentHarnessSelectionDecision: mocks.selection,
}));
vi.mock("./harness/runtime-plugin.js", async (importOriginal) => ({
  ...(await importOriginal<typeof HarnessPlugin>()),
  ensureSelectedAgentHarnessPlugin: async () => {},
}));

const repo = fileURLToPath(new URL("../../", import.meta.url));
const dirs = useAutoCleanupTempDirTracker(afterEach);
let root: string;
let preparedModelRuntime: object;

beforeEach(() => {
  vi.clearAllMocks();
  root = dirs.make("isolated-adapter-proof-");
  for (const key of ["HOME", "CODEX_HOME", "OPENCLAW_STATE_DIR"]) {
    vi.stubEnv(key, root);
  }
  preparedModelRuntime = {
    config: {},
    agentDir: root,
    workspaceDir: root,
    metadataSnapshot: createEmptyPluginMetadataSnapshot(root),
    pluginRegistry: createEmptyPluginRegistry(),
    createStores: () => ({ modelRegistry: {} }),
  };
  mocks.acquire.mockResolvedValue({
    snapshot: preparedModelRuntime,
    [Symbol.asyncDispose]: async () => {},
  });
});
afterEach(() => vi.unstubAllEnvs());

function registerHarness(harness: AgentHarness) {
  mocks.selection.mockReturnValue({
    policy: { runtime: "codex" },
    selectedHarnessId: "codex",
    selectedReason: "forced_plugin",
    candidates: [],
    builtIn: false,
    harness,
    ownerPluginId: "codex",
  });
}

function unexpectedSessionBinding(): never {
  throw new Error("Isolated completion must not access session bindings");
}

it.each(["allowed", "forbidden", "revoked"] as const)(
  "preserves account authority through the real Codex adapter: %s",
  async (scenario) => {
    const { createCodexAppServerAgentHarness } = await loadBundledPluginFacade<typeof CodexHarness>(
      {
        pluginId: "codex",
        artifactBasename: "harness.js",
      },
    );
    const { CODEX_APP_SERVER_VERSION } = await loadBundledPluginFacade<typeof CodexTestApi>({
      pluginId: "codex",
      artifactBasename: "test-api.js",
    });
    vi.stubEnv("OPENCLAW_QA_CODEX_APP_SERVER_VERSION", CODEX_APP_SERVER_VERSION);
    const log = path.join(root, "messages.jsonl");
    fs.writeFileSync(log, "");
    vi.stubEnv("OPENCLAW_QA_CODEX_AUTH_APP_SERVER_LOG", log);
    const platform = {
      provider: "openai",
      id: "gpt-test",
      name: "Test",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
    };
    const subscription = {
      ...platform,
      api: "openai-chatgpt-responses",
      baseUrl: "https://chatgpt.com/backend-api/codex",
    };
    const config: OpenClawConfig = {
      auth: {
        profiles: {
          "openai:allowed": { provider: "openai", mode: "oauth" },
          "openai:forbidden": { provider: "openai", mode: "api_key" },
        },
        order: { openai: ["openai:allowed"] },
      },
    };
    const credential = (identity: string) => ({
      type: "oauth" as const,
      provider: "openai",
      access: `synthetic-${identity}-access`,
      refresh: `synthetic-${identity}-refresh`,
      expires: 4102444800000,
      accountId: `synthetic-${identity}-account`,
    });
    const store: AuthProfileStore = {
      version: 1,
      profiles: {
        "openai:allowed": credential("allowed"),
        "openai:forbidden": credential("forbidden"),
      },
    };
    Object.assign(preparedModelRuntime, {
      config,
      modelCatalog: { entries: [platform], routeVariants: [platform, subscription] },
    });
    mocks.ensureAuthProfileStore.mockReturnValue(store);
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let resolutions = 0;
    let current = true;
    mocks.resolveModelAsync.mockImplementation(async () => {
      resolutions++;
      // Hold the real materializePreparedRuntimeModel await after route/auth planning.
      if (scenario === "revoked" && resolutions === 2) {
        enter();
        await gate;
      }
      return { model: resolutions === 1 ? platform : subscription };
    });
    const harness = createCodexAppServerAgentHarness({
      bindingStore: {
        read: unexpectedSessionBinding,
        readMany: unexpectedSessionBinding,
        readNativeSubagentSubmissions: unexpectedSessionBinding,
        hasOtherThreadOwner: unexpectedSessionBinding,
        mutate: unexpectedSessionBinding,
        prepareSessionGenerationReclaim: unexpectedSessionBinding,
        adoptSessionGeneration: unexpectedSessionBinding,
        resetSessionGeneration: unexpectedSessionBinding,
        retireSessionGeneration: unexpectedSessionBinding,
        withSessionDeletion: unexpectedSessionBinding,
        withThreadArchiveFence: unexpectedSessionBinding,
        withLease: unexpectedSessionBinding,
      },
      pluginConfig: {
        appServer: {
          command: process.execPath,
          args: [
            path.join(repo, "test/e2e/qa-lab/runtime/codex-isolated-app-server.fixture.mjs"),
            "app-server",
          ],
          transport: "stdio",
          homeScope: "agent",
        },
      },
    });
    registerHarness(harness);
    const pending = runIsolatedCompletion({
      config,
      provider: "openai",
      model: "gpt-test",
      systemPrompt: "Return text.",
      prompt: "Do the task.",
      agentHarnessRuntimeOverride: "codex",
      agentDir: root,
      workspaceDir: root,
      timeoutMs: 20000,
      authProfileId: scenario === "forbidden" ? "openai:forbidden" : "openai:allowed",
      assertCurrent() {
        if (!current) {
          throw new Error("synthetic caller authority revoked during preparation");
        }
      },
    });
    let outcome: unknown;
    try {
      if (scenario === "revoked") {
        await awaitGateBeforeSettlement(entered, pending, "Completion skipped awaited preparation");
        delete store.profiles["openai:allowed"];
        current = false;
        release();
      }
      if (scenario === "allowed") {
        const result = await pending;
        expect(result.text).toBe("Completed as synthetic-allowed-account");
        outcome = { text: result.text, owner: result.owner };
      } else {
        const error: unknown = await pending.then(
          () => undefined,
          (failure: unknown) => failure,
        );
        expect(error).toBeInstanceOf(Error);
        if (!(error instanceof Error)) {
          throw new Error("Expected rejection");
        }
        expect(error.message).toMatch(
          scenario === "forbidden" ? /not configured/ : /authority revoked/,
        );
        outcome = { rejected: true, error: error.message };
      }
    } finally {
      release();
      await harness.dispose?.();
    }
    const messages: Array<{ method?: string; params?: unknown }> = fs
      .readFileSync(log, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    if (scenario === "allowed") {
      const login = messages.find((message) => message.method === "account/login/start");
      expect(login?.params).toMatchObject({
        type: "chatgptAuthTokens",
        accessToken: "synthetic-allowed-access",
        chatgptAccountId: "synthetic-allowed-account",
      });
      expect(messages.filter((message) => message.method === "account/login/start")).toHaveLength(
        1,
      );
      expect(messages.findIndex((message) => message.method === "turn/start")).toBeGreaterThan(
        messages.findIndex((message) => message.method === "account/login/start"),
      );
    } else {
      expect(messages).toEqual([]);
    }
    const proofDir = process.env.OPENCLAW_TEST_ADAPTER_PROOF_DIR;
    if (proofDir) {
      const sanitized = JSON.parse(
        JSON.stringify(messages)
          .replaceAll(root, "<isolated-state>")
          .replaceAll("synthetic-allowed-access", "<synthetic-token:allowed>")
          .replaceAll("synthetic-forbidden-access", "<synthetic-token:forbidden>"),
      );
      fs.writeFileSync(
        path.join(proofDir, `${scenario}.json`),
        JSON.stringify({ scenario, outcome, messages: sanitized }, null, 2) + "\n",
      );
    }
  },
);
