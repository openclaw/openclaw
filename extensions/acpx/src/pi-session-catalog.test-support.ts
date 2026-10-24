import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/temp-path";
import { afterEach, vi } from "vitest";
import { createSessionCatalogContinuationStore } from "../../test-support/session-catalog-continuation.test-support.js";
import { registerPiSessionCatalog } from "./pi-session-catalog-plugin.js";

type RegisteredSessionCatalogProvider = Parameters<OpenClawPluginApi["registerSessionCatalog"]>[0];
type NodeCommand = Parameters<OpenClawPluginApi["registerNodeHostCommand"]>[0];
type OptionalCatalogAgent<T extends { agentId?: string }> = Omit<T, "agentId"> & {
  agentId?: string;
};
type CatalogOperation = "list" | "read" | "continueSession" | "archive" | "openTerminal";
export type TestSessionCatalogProvider = Omit<
  RegisteredSessionCatalogProvider,
  CatalogOperation
> & {
  [K in keyof Pick<RegisteredSessionCatalogProvider, CatalogOperation>]: (
    params: OptionalCatalogAgent<Parameters<NonNullable<RegisteredSessionCatalogProvider[K]>>[0]>,
  ) => ReturnType<NonNullable<RegisteredSessionCatalogProvider[K]>>;
};

export const piSessionHeader = (overrides: Record<string, unknown> = {}) => ({
  type: "session",
  version: 3,
  id: "pi-session",
  timestamp: "2026-07-13T10:00:00.000Z",
  cwd: "/workspace",
  ...overrides,
});
export const piMessage = (
  message: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
) => ({
  type: "message",
  timestamp: "2026-07-13T10:00:01.000Z",
  message,
  ...overrides,
});
export const piJsonl = (entries: unknown[]) =>
  `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;

function restorePiEnvironment(original: NodeJS.ProcessEnv) {
  for (const [key, value] of Object.entries(original)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

export function usePiFixtures() {
  const directories: string[] = [];
  const original = Object.fromEntries(
    ["PI_CODING_AGENT_SESSION_DIR", "PI_CODING_AGENT_DIR", "HOME", "USERPROFILE", "PATH"].map(
      (key) => [key, process.env[key]],
    ),
  );
  afterEach(async () => {
    vi.restoreAllMocks();
    restorePiEnvironment(original);
    await Promise.all(
      directories.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
    );
  });
  return {
    directories,
    createStore: createPiStoreFixture.bind(null, directories),
    installPi: () => installFakePiFixture(directories, original.PATH),
  };
}

export function capturePiCatalog(
  runtime: {
    config?: Pick<OpenClawPluginApi["runtime"]["config"], "current">;
    nodes: Partial<OpenClawPluginApi["runtime"]["nodes"]>;
    agent?: { session: Partial<OpenClawPluginApi["runtime"]["agent"]["session"]> };
  } = {
    config: { current: () => ({}) },
    nodes: { list: vi.fn().mockResolvedValue({ nodes: [] }) },
  },
  context: Partial<Pick<OpenClawPluginApi, "id" | "config">> = {},
) {
  let provider: TestSessionCatalogProvider | undefined;
  const commands: NodeCommand[] = [];
  registerPiSessionCatalog({
    ...context,
    pluginConfig: {},
    runtime,
    registerSessionCatalog: (value: RegisteredSessionCatalogProvider) => {
      provider = bindTestCatalogOwner(value);
    },
    registerNodeHostCommand: (command: NodeCommand) => commands.push(command),
    registerNodeInvokePolicy: vi.fn(),
  } as unknown as OpenClawPluginApi);
  return { provider: provider!, commands };
}

function bindTestCatalogOwner(
  provider: RegisteredSessionCatalogProvider,
): TestSessionCatalogProvider {
  const { continueSession, archive, openTerminal } = provider;
  return {
    ...provider,
    list: (params) => provider.list({ agentId: "main", ...params }),
    read: (params) => provider.read({ agentId: "main", ...params }),
    ...(continueSession && {
      continueSession: (params) => continueSession.call(provider, { agentId: "main", ...params }),
    }),
    ...(archive && { archive: (params) => archive.call(provider, { agentId: "main", ...params }) }),
    ...(openTerminal && {
      openTerminal: (params) => openTerminal.call(provider, { agentId: "main", ...params }),
    }),
  } as TestSessionCatalogProvider;
}

export async function createPiStoreFixture(
  temporaryDirectories: string[],
  assistantText = "hi",
  sessionName = "Pi catalog session",
  toolArguments: unknown = { command: "pwd" },
  acpResolvable = false,
): Promise<string> {
  const root = await fs.mkdtemp(
    path.join(resolvePreferredOpenClawTmpDir(), "openclaw-pi-catalog-"),
  );
  temporaryDirectories.push(root);
  const directory = acpResolvable ? path.join(root, "sessions", "project") : root;
  if (acpResolvable) {
    await fs.mkdir(directory, { recursive: true });
    delete process.env.PI_CODING_AGENT_SESSION_DIR;
    process.env.PI_CODING_AGENT_DIR = root;
  } else {
    process.env.PI_CODING_AGENT_SESSION_DIR = directory;
  }
  const messages = [
    { role: "user", content: "hello" },
    {
      role: "assistant",
      provider: "anthropic",
      model: "claude",
      content: [
        { type: "thinking", thinking: "thinking" },
        { type: "text", text: assistantText },
        { type: "toolCall", id: "call-1", name: "bash", arguments: toolArguments },
      ],
    },
    {
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "bash",
      content: [{ type: "text", text: "/workspace" }],
    },
  ];
  const ids = ["user-1", "assistant-1", "tool-1"];
  const entries = [
    piSessionHeader(),
    ...messages.map((message, index) =>
      piMessage(
        { ...message, timestamp: 1_783_938_001_000 + index * 1_000 },
        {
          id: ids[index],
          parentId: index === 0 ? null : ids[index - 1],
          timestamp: `2026-07-13T10:00:0${index + 1}.000Z`,
        },
      ),
    ),
    {
      type: "session_info",
      id: "info-1",
      parentId: "tool-1",
      timestamp: "2026-07-13T10:00:04.000Z",
      name: sessionName,
    },
  ];
  await fs.writeFile(path.join(directory, "session.jsonl"), piJsonl(entries));
  return directory;
}

async function installFakePiFixture(
  temporaryDirectories: string[],
  originalPath: string | undefined,
): Promise<string> {
  const directory = await fs.mkdtemp(
    path.join(resolvePreferredOpenClawTmpDir(), "openclaw-pi-cli-"),
  );
  temporaryDirectories.push(directory);
  const bareExecutable = path.join(directory, "pi");
  await fs.writeFile(bareExecutable, "#!/bin/sh\nexit 0\n");
  if (process.platform === "win32") {
    await fs.writeFile(path.join(directory, "pi.cmd"), "@echo off\r\nexit /b 0\r\n");
  } else {
    await fs.chmod(bareExecutable, 0o755);
  }
  process.env.PATH = `${directory}${path.delimiter}${originalPath ?? ""}`;
  return directory;
}

export function capturePiContinuationCatalog() {
  const { entries, createSessionEntry } = createSessionCatalogContinuationStore(
    "acpx",
    "adopted-pi-session",
  );
  const { provider } = capturePiCatalog(
    {
      config: { current: () => ({}) },
      nodes: { list: vi.fn().mockResolvedValue({ nodes: [] }) },
      agent: {
        session: {
          createSessionEntry,
          listSessionEntries: vi.fn(() => entries),
        },
      },
    },
    { id: "acpx", config: {} },
  );
  return { createSessionEntry, entries, provider };
}
