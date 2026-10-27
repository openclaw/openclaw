import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import type { SessionTranscriptWriteContext } from "openclaw/plugin-sdk/session-transcript-runtime";
import { withEnvAsync } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSessionCatalogContinuationStore as createContinuationStore } from "../test-support/session-catalog-continuation.test-support.js";

type ResolveAcpSessionAvailability =
  (typeof import("openclaw/plugin-sdk/acp-runtime"))["resolveAcpSessionAvailability"];
type RunCommandBuffered =
  (typeof import("openclaw/plugin-sdk/process-runtime"))["runCommandBuffered"];
type SessionCatalogProvider = Parameters<OpenClawPluginApi["registerSessionCatalog"]>[0];
type NodeHostCommand = Parameters<OpenClawPluginApi["registerNodeHostCommand"]>[0];
type NodeInvokePolicy = Parameters<OpenClawPluginApi["registerNodeInvokePolicy"]>[0];
type CatalogListParams = Parameters<SessionCatalogProvider["list"]>[0];
type CatalogReadParams = Parameters<SessionCatalogProvider["read"]>[0];

function bindTestCatalogOwner(provider: SessionCatalogProvider): SessionCatalogProvider {
  return {
    ...provider,
    list: (params) => provider.list({ agentId: "main", ...params }),
    read: (params) => provider.read({ agentId: "main", ...params }),
    continueSession: (params) => provider.continueSession!({ agentId: "main", ...params }),
    openTerminal: (params) => provider.openTerminal!({ agentId: "main", ...params }),
  } as SessionCatalogProvider;
}

const nodeHostMocks = await vi.hoisted(async () => {
  const { createNodeHostMocks } = await import("../test-support/node-host.test-support.js");
  return createNodeHostMocks();
});
const acpRuntimeMocks = vi.hoisted(() => ({
  resolveAcpSessionAvailability: vi.fn<ResolveAcpSessionAvailability>(() => ({ available: true })),
}));
const runCommand = vi.hoisted(() => vi.fn<RunCommandBuffered>());
const transcriptMocks = vi.hoisted(() => ({
  messages: [] as Array<Record<string, unknown>>,
}));

vi.mock("openclaw/plugin-sdk/process-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/process-runtime")>();
  runCommand.mockImplementation(actual.runCommandBuffered);
  return { ...actual, runCommandBuffered: runCommand };
});

vi.mock("openclaw/plugin-sdk/acp-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/acp-runtime")>()),
  resolveAcpSessionAvailability: acpRuntimeMocks.resolveAcpSessionAvailability,
}));

vi.mock("openclaw/plugin-sdk/session-transcript-runtime", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("openclaw/plugin-sdk/session-transcript-runtime")>();
  return {
    ...actual,
    withSessionTranscriptWrite: async (
      _params: unknown,
      run: (context: Pick<SessionTranscriptWriteContext, "appendMessage">) => Promise<void>,
    ) => {
      await run({
        appendMessage: async ({ message, idempotencyLookup }) => {
          const record = message as Record<string, unknown>;
          const key = record.idempotencyKey;
          if (
            idempotencyLookup === "scan" &&
            typeof key === "string" &&
            transcriptMocks.messages.some((candidate) => candidate.idempotencyKey === key)
          ) {
            return;
          }
          transcriptMocks.messages.push(record);
        },
      });
    },
  };
});

// mock-isolation: Shared owner preserves real exports with fresh command-resolution mocks.
vi.mock("openclaw/plugin-sdk/node-host", nodeHostMocks.mockRuntime);

import { registerOpenCodeSessionCatalog } from "./session-catalog-plugin.js";
import {
  OPENCODE_SESSIONS_LIST_COMMAND,
  OPENCODE_SESSION_READ_COMMAND,
  OPENCODE_TERMINAL_RESUME_COMMAND,
} from "./session-catalog-shared.js";
import {
  listLocalOpenCodeSessionPage,
  readLocalOpenCodeTranscriptPage,
} from "./session-catalog.js";

const temporaryDirectories: string[] = [];
const originalPath = process.env.PATH;
const localLocator = { hostId: "gateway", threadId: "ses_test" } as const;
const localOnly = { hostIds: ["gateway"] };
const disabledCatalog = { sessionCatalog: { enabled: false } };
const pairedNodeLocator = { hostId: "node:node-1", threadId: "ses_remote" } as const;
const removeDirectory = (directory: string) => fs.rm(directory, { recursive: true, force: true });

function captureOpenCodeSessionRegistrations(
  pluginConfig: OpenClawPluginApi["pluginConfig"] = {},
  overrides: Record<string, unknown> = {},
) {
  const catalogs: SessionCatalogProvider[] = [];
  const commands: NodeHostCommand[] = [];
  const policies: NodeInvokePolicy[] = [];
  registerOpenCodeSessionCatalog(
    createTestPluginApi({
      id: "opencode",
      pluginConfig,
      runtime: {
        config: { current: () => ({}) },
        nodes: { list: vi.fn().mockResolvedValue({ nodes: [] }) },
      } as unknown as OpenClawPluginApi["runtime"],
      ...(overrides as Partial<OpenClawPluginApi>),
      registerSessionCatalog: (catalog: SessionCatalogProvider) =>
        catalogs.push(bindTestCatalogOwner(catalog)),
      registerNodeHostCommand: (command: NodeHostCommand) => commands.push(command),
      registerNodeInvokePolicy: (policy: NodeInvokePolicy) => policies.push(policy),
    }),
  );
  return { catalogs, commands, policies, provider: catalogs[0] };
}

function pairedNodeSession(overrides: Record<string, unknown> = {}) {
  return {
    threadId: "ses_remote",
    status: "stored",
    archived: false,
    canContinue: false,
    canArchive: false,
    ...overrides,
  };
}

const nodePayload = (payload: unknown) => ({ payloadJSON: JSON.stringify(payload) });

function pairedNodeSessionPage(...sessions: Array<Record<string, unknown>>) {
  return nodePayload({ sessions });
}

const pairedNode = (commands: string[], overrides: Record<string, unknown> = {}) => ({
  nodeId: "node-1",
  connected: true,
  commands,
  ...overrides,
});

function capturePairedNodeCatalog(nodes: Array<Record<string, unknown>>, invoke: unknown) {
  const listNodes = vi.fn().mockResolvedValue({ nodes });
  const { provider } = captureOpenCodeSessionRegistrations(
    {},
    {
      runtime: { config: { current: () => ({}) }, nodes: { list: listNodes, invoke } },
    },
  );
  return { listNodes, provider };
}

const listPairedNode = (
  provider: SessionCatalogProvider,
  params: Omit<CatalogListParams, "hostIds"> = {},
) => provider.list({ hostIds: [pairedNodeLocator.hostId], ...params });

const readPairedNode = (
  provider: SessionCatalogProvider,
  params: Omit<CatalogReadParams, "hostId" | "threadId"> = {},
) => provider.read({ ...pairedNodeLocator, ...params });

const readTestTranscript = (params: Record<string, unknown> = {}) =>
  readLocalOpenCodeTranscriptPage({ threadId: "ses_test", ...params });

const continueLocal = (provider: SessionCatalogProvider) => provider.continueSession!(localLocator);
const localSessions = (provider: SessionCatalogProvider) => provider.list(localOnly);
const executablePath = (directory: string) =>
  path.join(directory, process.platform === "win32" ? "opencode.cmd" : "opencode");

function expectSessions(sessions: Array<Record<string, unknown>>) {
  return [
    expect.objectContaining({
      sessions: sessions.map((session) => expect.objectContaining(session)),
    }),
  ];
}

async function expectRejects(promise: Promise<unknown>, message: string) {
  await expect(promise).rejects.toThrow(message);
}

async function expectPairedNodeListError(
  provider: SessionCatalogProvider,
  params: Omit<CatalogListParams, "hostIds"> = {},
) {
  await expect(listPairedNode(provider, params)).resolves.toEqual([
    expect.objectContaining({
      error: { code: "NODE_INVOKE_FAILED", message: expect.any(String) },
    }),
  ]);
}

const nodeInvokeRequest = (command: string, params: Record<string, unknown>) => ({
  nodeId: "node-1",
  command,
  params,
  timeoutMs: 35_000,
  scopes: ["operator.write"],
});

function captureOpenCodeContinuationCatalog() {
  const { entries, createSessionEntry } = createContinuationStore(
    "opencode",
    "adopted-opencode-session",
  );
  const runtime = {
    config: { current: () => ({}) },
    nodes: { list: vi.fn().mockResolvedValue({ nodes: [] }) },
    agent: { session: { createSessionEntry, listSessionEntries: vi.fn(() => entries) } },
  };
  const { provider } = captureOpenCodeSessionRegistrations(
    {},
    { id: "opencode", config: {}, runtime },
  );
  return { createSessionEntry, entries, provider: provider! };
}

async function installFakeOpenCode({
  toolInput = { command: "pwd" },
  version = 1,
  archivedFirst = false,
}: { toolInput?: unknown; version?: number; archivedFirst?: boolean } = {}): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-opencode-catalog-"));
  temporaryDirectories.push(directory);
  const executable = path.join(directory, "opencode");
  const session = {
    id: "ses_test",
    title: "Catalog session",
    created: 1_700_000_000_000,
    updated: 1_700_000_001_000,
    directory: "/workspace",
  };
  const model = { providerID: "anthropic", modelID: "claude" };
  const exported = {
    info: session,
    messages: [
      {
        info: { id: "msg_user", role: "user", time: { created: session.created }, model },
        parts: [{ id: "prt_user", type: "text", text: "hello" }],
      },
      {
        info: {
          id: "msg_assistant",
          role: "assistant",
          time: { created: session.updated },
          ...model,
        },
        parts: [
          { id: "prt_reason", type: "reasoning", text: "thinking" },
          { id: "prt_answer", type: "text", text: "hi" },
          {
            id: "prt_tool",
            type: "tool",
            tool: "bash",
            state: { status: "completed", input: toolInput, output: "/workspace" },
          },
        ],
      },
    ],
  };
  const script = `#!/usr/bin/env node
const args = process.argv.slice(2);
const session = ${JSON.stringify(session)};
const exported = ${JSON.stringify(exported)};
const write = (value) => process.stdout.write(JSON.stringify(value));
if (process.env.CATALOG_UNRELATED_ENV) process.exit(3);
if (args[0] === "--version") {
  process.stdout.write(${JSON.stringify(`${version}.0.0`)});
  process.exit(0);
}
if (${version} === 2) {
  if (args.includes("--pure") || !args.includes("--standalone")) process.exit(2);
  if (process.env.OPENCODE_CONFIG_PROJECT_DISABLE !== "1" || !process.env.OPENCODE_CONFIG_DIR) process.exit(3);
  if (args[0] === "api" && args[2] === "session.list") {
    if (${archivedFirst} && !args.some((arg) => arg.startsWith("cursor="))) {
      write({
        data: Array.from({ length: 100 }, (_, id) => ({
          id: "ses_archived" + id, time: { archived: 1 }, location: { directory: "/workspace" },
        })),
        cursor: { next: "live-page" },
      });
      process.exit(0);
    }
    write({ data: [{ id: session.id, title: session.title,
      time: { created: session.created, updated: session.updated },
      location: { directory: session.directory } }] });
  } else if (args[0] === "session" && args[1] === "export") {
    write({ info: session, messages: exported.messages.map(({ info, parts }) => ({
      id: info.id, type: info.role, time: info.time,
      ...(info.role === "user" ? { text: parts[0].text } : {
        model: ${JSON.stringify(model)},
        content: parts.map(({ id, ...part }) => part.type === "tool" ? {
          id, type: "tool", name: part.tool,
          state: { status: part.state.status, input: part.state.input,
            content: [{ type: "text", text: part.state.output }] },
        } : part),
      }),
    })) });
  } else process.exitCode = 2;
  process.exit();
}
if (args[0] === "--pure" && args[1] === "db" && args.includes("--format") && args.includes("json")) {
  write(args[2].includes("event_sequence") ? [{ id: "ses_test", seq: 4 }] : [session]);
} else if (args[0] === "--pure" && args[1] === "export" && args[2] === "ses_test") {
  write(exported);
} else {
  process.exitCode = 2;
}
`;
  await fs.writeFile(`${executable}.js`, script);
  if (process.platform === "win32") {
    // This exact direct-forwarder shape is parsed into a Node entrypoint;
    // the batch wrapper itself is never executed through cmd.exe.
    await fs.writeFile(
      path.join(directory, "opencode.cmd"),
      '@echo off\r\n"%~dp0\\opencode.js" %*\r\n',
    );
  } else {
    // A concurrent fork can retain the generated payload's write FD after close.
    // Execute an immutable inode and let Node read the payload as ordinary data.
    await fs.symlink(new URL("./test-fixtures/opencode-command.sh", import.meta.url), executable);
  }
  vi.stubEnv("PATH", `${directory}${path.delimiter}${originalPath ?? ""}`);
  vi.stubEnv("CATALOG_UNRELATED_ENV", "present");
  return directory;
}

afterEach(async () => {
  acpRuntimeMocks.resolveAcpSessionAvailability.mockReset().mockReturnValue({ available: true });
  nodeHostMocks.runNodePtyCommand.mockClear();
  runCommand.mockClear();
  transcriptMocks.messages.length = 0;
  vi.unstubAllEnvs();
  await Promise.all(temporaryDirectories.splice(0).map(removeDirectory));
});

const itWithCli = it.runIf(process.platform !== "win32");

describe("OpenCode session catalog", () => {
  itWithCli.each(["runtime", "request"] as const)(
    "discovers paired nodes only for selected hosts through the %s node runtime",
    async (discovery) => {
      await installFakeOpenCode();
      const nodes = [pairedNode([OPENCODE_SESSIONS_LIST_COMMAND])];
      const invoke = vi.fn().mockResolvedValue(pairedNodeSessionPage(pairedNodeSession()));
      const { listNodes: runtimeListNodes, provider } = capturePairedNodeCatalog(nodes, invoke);
      const requestListNodes = vi.fn().mockResolvedValue({ nodes });
      const options = discovery === "request" ? { listNodes: requestListNodes } : {};
      for (const hostIds of [["gateway"], [], ["unknown"]]) {
        const hosts = await provider!.list({ ...options, hostIds });
        expect(hosts.map((host) => host.hostId)).toEqual(
          hostIds[0] === "gateway" ? ["gateway"] : [],
        );
        if (hostIds[0] === "gateway") {
          expect(hosts[0]?.sessions[0]?.threadId).toBe("ses_test");
        }
        expect(runtimeListNodes).not.toHaveBeenCalled();
        expect(requestListNodes).not.toHaveBeenCalled();
        expect(invoke).not.toHaveBeenCalled();
      }

      for (const hostIds of [undefined, ["gateway", "node:node-1"], ["node:node-1"]]) {
        const hosts = await provider!.list({ ...options, ...(hostIds ? { hostIds } : {}) });
        expect(hosts.map((host) => host.hostId)).toEqual(
          hostIds?.length === 1 ? ["node:node-1"] : ["gateway", "node:node-1"],
        );
        expect(hosts.at(-1)?.sessions[0]?.threadId).toBe("ses_remote");
      }
      const hostIds = ["gateway", "node:node-1"];
      const hosts = await provider!.list({
        ...options,
        hostIds,
        onHost: () => {
          hostIds.length = 0;
        },
      });
      expect(hosts.map((host) => host.hostId)).toEqual(["gateway", "node:node-1"]);
      expect(discovery === "request" ? runtimeListNodes : requestListNodes).not.toHaveBeenCalled();
    },
  );

  itWithCli.each([1, 2])(
    "lists and reads sessions through the v%s CLI JSON surfaces",
    async (version) => {
      await installFakeOpenCode({ version });
      const listed = await listLocalOpenCodeSessionPage({ limit: 20 });
      const expectedSession = {
        threadId: "ses_test",
        name: "Catalog session",
        cwd: "/workspace",
        source: "opencode-cli",
        canContinue: true,
      };
      expect(listed).toEqual({ sessions: [expect.objectContaining(expectedSession)] });

      const transcript = await readTestTranscript({ limit: 20 });
      expect(transcript.items.map((item) => [item.type, item.text])).toEqual([
        ["toolResult", "/workspace"],
        ["toolCall", 'bash\n{"command":"pwd"}'],
        ["agentMessage", "hi"],
        ["reasoning", "thinking"],
        ["userMessage", "hello"],
      ]);
      const itemIds = transcript.items.flatMap((item) => (item.id ? [item.id] : []));
      expect(new Set(itemIds).size).toBe(itemIds.length);

      const latest = await readTestTranscript({ limit: 2 });
      expect(latest.items.map((item) => item.type)).toEqual(["toolResult", "toolCall"]);
      expect(latest.nextCursor).toBeTruthy();
      const older = await readTestTranscript({ limit: 2, cursor: latest.nextCursor });
      expect(older.items.map((item) => item.type)).toEqual(["agentMessage", "reasoning"]);
      await expectRejects(
        readLocalOpenCodeTranscriptPage({ threadId: "--help" }),
        "threadId is invalid",
      );
    },
  );

  itWithCli("finds live v2 sessions behind an archived API page", async () => {
    await installFakeOpenCode({ toolInput: {}, version: 2, archivedFirst: true });
    const { provider } = captureOpenCodeSessionRegistrations();
    const hosts = await provider!.list({ limitPerHost: 1 });
    expect(hosts[0]?.sessions.map((session) => session.threadId)).toEqual(["ses_test"]);

    const now = performance.now();
    const perfSpy = vi.spyOn(performance, "now").mockReturnValue(now);
    const run = runCommand.getMockImplementation()!;
    runCommand.mockImplementationOnce(async (...args) => {
      const result = await run(...args);
      perfSpy.mockReturnValue(now + 30_001);
      return result;
    });
    try {
      await expect(
        listLocalOpenCodeSessionPage({ limit: 1 }, { forceRefresh: true }),
      ).rejects.toThrow("OpenCode session scan exceeded the time limit");
    } finally {
      perfSpy.mockRestore();
    }
  });

  itWithCli("bounds per-page CLI budgets when the wall clock runs backwards", async () => {
    await installFakeOpenCode({ toolInput: {}, version: 2, archivedFirst: true });
    const { provider } = captureOpenCodeSessionRegistrations();
    const wallNow = Date.now();
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(wallNow);
    const captured: number[] = [];
    const run = runCommand.getMockImplementation()!;
    runCommand.mockImplementation(async (...args) => {
      const [argv, opts] = args;
      if (argv.includes("session.list") && typeof opts?.timeoutMs === "number") {
        captured.push(opts.timeoutMs);
      }
      const result = await run(...args);
      if (captured.length === 1) {
        nowSpy.mockReturnValue(wallNow - 60_000);
      }
      return result;
    });
    try {
      const hosts = await provider!.list({ limitPerHost: 1 });
      expect(hosts[0]?.sessions.map((session) => session.threadId)).toEqual(["ses_test"]);
      expect(captured).toHaveLength(2);
      expect(captured[1]!).toBeLessThanOrEqual(captured[0]!);
    } finally {
      nowSpy.mockRestore();
      runCommand.mockImplementation(run);
    }
  });

  itWithCli("allows a relative OPENCODE_DB as an explicit isolated-state root", async () => {
    await installFakeOpenCode();
    const { provider } = captureOpenCodeSessionRegistrations();
    const isolated = { ...localLocator, allowProcessHomeFallback: false };

    await withEnvAsync(
      { OPENCODE_DB: undefined, XDG_DATA_HOME: undefined },
      async () =>
        await Promise.all([
          expect(
            provider!.list({ ...localOnly, allowProcessHomeFallback: false }),
          ).resolves.toEqual([]),
          expect(provider!.continueSession?.(isolated)).rejects.toThrow(
            "local OpenCode sessions are unavailable in isolated state",
          ),
          expect(provider!.openTerminal?.(isolated)).rejects.toThrow(
            "local OpenCode sessions are unavailable in isolated state",
          ),
        ]),
    );
    await withEnvAsync({ OPENCODE_DB: "relative.db", XDG_DATA_HOME: undefined }, async () => {
      await expect(
        provider!.list({ ...localOnly, allowProcessHomeFallback: false }),
      ).resolves.toEqual([expect.objectContaining({ hostId: "gateway" })]);
      await expect(provider!.read(isolated)).resolves.toMatchObject(localLocator);
    });
  });

  itWithCli("memoizes the CLI database query until explicit refresh or expiry", async () => {
    await installFakeOpenCode();
    let now = 1_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      await listLocalOpenCodeSessionPage({ limit: 20 });
      for (const [elapsed, forceRefresh, calls] of [
        [0, false, 2],
        [31_999, false, 2],
        [0, true, 3],
        [32_001, false, 5],
      ] as const) {
        now += elapsed;
        await listLocalOpenCodeSessionPage({ limit: 20 }, { forceRefresh });
        expect(runCommand).toHaveBeenCalledTimes(calls);
      }
    } finally {
      nowSpy.mockRestore();
    }
  });

  itWithCli("hides and rejects Continue when ACP cannot resume OpenCode", async () => {
    await installFakeOpenCode();
    acpRuntimeMocks.resolveAcpSessionAvailability.mockReturnValue({
      available: false,
      message: "ACP runtime backend is unavailable",
    });
    const { provider } = captureOpenCodeContinuationCatalog();

    await expect(localSessions(provider)).resolves.toEqual(
      expectSessions([{ threadId: "ses_test", canContinue: false }]),
    );
    await expectRejects(continueLocal(provider), "ACP runtime backend is unavailable");
  });

  itWithCli("adopts local OpenCode sessions once with the native ACP resume binding", async () => {
    await installFakeOpenCode();
    const { createSessionEntry, entries, provider } = captureOpenCodeContinuationCatalog();
    const sessionEntries = { entriesForAgent: () => entries } as never;
    const listed = () => provider.list({ ...localOnly, sessionEntries });
    expect((await listed())[0]?.sessions[0]).not.toHaveProperty("sessionKey");

    const [first, concurrent] = await Promise.all([
      continueLocal(provider),
      continueLocal(provider),
    ]);
    const second = await continueLocal(provider);

    expect([concurrent, second]).toEqual([first, first]);
    expect((await listed())[0]?.sessions[0]).toMatchObject({
      threadId: "ses_test",
      sessionKey: first.sessionKey,
    });
    expect(first.upstream).toEqual({
      kind: "opencode-cli",
      ref: { threadId: "ses_test" },
      marker: {
        seq: 4,
        lastHumanMessageId: "msg_user",
      },
    });
    expect(createSessionEntry).toHaveBeenCalledTimes(1);
    expect(createSessionEntry.mock.calls[0]?.[0]).not.toHaveProperty("label");
    expect(createSessionEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        displayName: "Catalog session",
        spawnedCwd: "/workspace",
        initialEntry: {
          acpBackendId: "acpx",
          acpSessionBinding: { acpAgentId: "opencode", agentSessionId: "ses_test" },
          pluginExtensions: {
            opencode: { sessionCatalog: { sourceThreadId: "ses_test" } },
          },
        },
      }),
    );
    expect(
      transcriptMocks.messages.map((message) =>
        typeof message.content === "string"
          ? message.content
          : (message.content as Array<{ text: string }>)[0]?.text,
      ),
    ).toEqual([
      "hello",
      "Thinking\n\nthinking",
      "hi",
      'Tool call\n\nbash\n{"command":"pwd"}',
      "Tool result\n\n/workspace",
    ]);
    expect(transcriptMocks.messages[0]?.["__openclaw"]).toEqual({
      mirrorOrigin: "opencode-catalog-import",
      catalogDisplay: { type: "userMessage" },
    });
  });

  itWithCli("rejects paired-node and unknown OpenCode session continuation", async () => {
    await installFakeOpenCode();
    const { createSessionEntry, provider } = captureOpenCodeContinuationCatalog();

    await expectRejects(
      provider.continueSession!({ hostId: "node:remote", threadId: "ses_test" }),
      "paired-node OpenCode session rows are view-only",
    );
    await expectRejects(
      provider.continueSession!({ hostId: "gateway", threadId: "missing" }),
      "OpenCode session is unavailable",
    );
    expect(createSessionEntry).not.toHaveBeenCalled();
  });

  itWithCli("keeps truncated tool input on a valid UTF-16 boundary", async () => {
    await installFakeOpenCode({ toolInput: { value: `${"x".repeat(19_989)}🎉` } });
    const transcript = await readTestTranscript({ limit: 20 });
    const toolCall = transcript.items.find((item) => item.type === "toolCall");

    expect(toolCall?.text).toMatch(/…$/u);
    expect(toolCall?.text).not.toMatch(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u,
    );
  });

  itWithCli("auto-detects the CLI and honors the node-local Web UI switch", async () => {
    const directory = await installFakeOpenCode();
    const { commands } = captureOpenCodeSessionRegistrations();
    const commandsAvailable = (config: unknown, PATH: string) =>
      commands.every((command) => command.isAvailable?.({ config, env: { PATH } } as never));
    expect(commandsAvailable({}, directory)).toBe(true);
    expect(
      commandsAvailable(
        { plugins: { entries: { opencode: { config: disabledCatalog } } } },
        directory,
      ),
    ).toBe(false);
    expect(commandsAvailable({}, path.join(directory, "missing"))).toBe(false);
  });

  it("opens validated local sessions with the upstream terminal resume contract", async () => {
    const directory = await installFakeOpenCode();
    const executable = executablePath(directory);
    const { provider } = captureOpenCodeSessionRegistrations();

    await expect(localSessions(provider!)).resolves.toEqual(
      expectSessions([{ threadId: "ses_test", canOpenTerminal: true }]),
    );
    await expect(provider!.openTerminal!(localLocator)).resolves.toEqual({
      kind: "local",
      argv: [executable, "--session", "ses_test"],
      cwd: "/workspace",
      title: "opencode --session ses_test…",
    });
    await expectRejects(
      provider!.openTerminal!({ hostId: "gateway", threadId: "missing" }),
      "OpenCode session is unavailable",
    );
  });

  it("runs only catalog-validated OpenCode sessions through the node PTY", async () => {
    const directory = await installFakeOpenCode();
    const executable = executablePath(directory);
    const { commands, policies } = captureOpenCodeSessionRegistrations();
    const terminal = commands.find(
      (command) => command.command === OPENCODE_TERMINAL_RESUME_COMMAND,
    );
    const io = {
      signal: new AbortController().signal,
      onInput: vi.fn(),
      emitChunk: vi.fn(),
    };
    await expect(
      terminal!.handle?.(
        JSON.stringify({ threadId: "ses_test", cols: 100, rows: 30 }),
        io as never,
      ),
    ).resolves.toBe(JSON.stringify({ exitCode: 0 }));
    expect(nodeHostMocks.runNodePtyCommand).toHaveBeenCalledWith(
      {
        file: executable,
        args: ["--session", "ses_test"],
        cwd: "/workspace",
        cols: 100,
        rows: 30,
      },
      io,
    );
    await expect(
      terminal!.handle?.(JSON.stringify({ threadId: "--help", cols: 100, rows: 30 }), io as never),
    ).rejects.toThrow("threadId is invalid");

    const invokeNode = vi.fn(() => ({ ok: false as const, error: "unexpected" }));
    const policy = policies[0]!;
    expect(
      policy.handle({ command: OPENCODE_TERMINAL_RESUME_COMMAND, invokeNode } as never),
    ).toEqual({ ok: true });
    expect(policy.handle({ command: OPENCODE_SESSIONS_LIST_COMMAND, invokeNode } as never)).toEqual(
      { ok: false, error: "unexpected" },
    );
  });

  it("marks paired-node sessions terminal-capable only when the resume command is advertised", async () => {
    const page = pairedNodeSessionPage({
      ...pairedNodeSession(),
      cwd: "/remote/workspace",
      canContinue: true,
    });
    const invoke = vi.fn().mockResolvedValue(page);
    const nodes = [pairedNode([OPENCODE_SESSIONS_LIST_COMMAND, OPENCODE_TERMINAL_RESUME_COMMAND])];
    const requestListNodes = vi.fn().mockResolvedValue({ nodes });
    const { listNodes: runtimeListNodes, provider } = capturePairedNodeCatalog(nodes, invoke);

    await expect(
      listPairedNode(provider!, { search: "remote", listNodes: requestListNodes }),
    ).resolves.toEqual(
      expectSessions([{ threadId: "ses_remote", canContinue: false, canOpenTerminal: true }]),
    );
    expect(runtimeListNodes).not.toHaveBeenCalled();
    await expect(provider!.openTerminal!(pairedNodeLocator)).resolves.toEqual({
      kind: "node",
      nodeId: "node-1",
      command: OPENCODE_TERMINAL_RESUME_COMMAND,
      uploadPathStyle: "native",
      paramsJSON: JSON.stringify({ threadId: "ses_remote" }),
      cwd: "/remote/workspace",
      title: "opencode --session ses_remote…",
    });
    expect(invoke).toHaveBeenLastCalledWith(
      nodeInvokeRequest(OPENCODE_SESSIONS_LIST_COMMAND, {
        searchTerm: "ses_remote",
        limit: 100,
      }),
    );
  });

  it("does not register the catalog when explicitly disabled", () => {
    const { provider: _provider, ...registrations } =
      captureOpenCodeSessionRegistrations(disabledCatalog);
    expect(registrations).toEqual({ catalogs: [], commands: [], policies: [] });
  });

  it("bridges paired-node list and read requests without undefined transport fields", async () => {
    const invoke = vi
      .fn()
      .mockResolvedValueOnce(pairedNodeSessionPage(pairedNodeSession({ source: "opencode-cli" })))
      .mockResolvedValueOnce(
        nodePayload({
          threadId: "ses_remote",
          items: [{ type: "agentMessage", text: "remote answer" }],
        }),
      );
    const { provider: catalog } = capturePairedNodeCatalog(
      [
        pairedNode([OPENCODE_SESSIONS_LIST_COMMAND, OPENCODE_SESSION_READ_COMMAND], {
          displayName: "Remote",
        }),
      ],
      invoke,
    );
    await expect(listPairedNode(catalog!)).resolves.toEqual(
      expectSessions([{ threadId: "ses_remote", canContinue: false, source: "opencode-cli" }]),
    );
    await expect(readPairedNode(catalog!)).resolves.toMatchObject({
      threadId: "ses_remote",
      items: [{ type: "agentMessage", text: "remote answer" }],
    });

    expect(invoke.mock.calls).toEqual([
      [nodeInvokeRequest(OPENCODE_SESSIONS_LIST_COMMAND, {})],
      [nodeInvokeRequest(OPENCODE_SESSION_READ_COMMAND, { threadId: "ses_remote" })],
    ]);
  });

  it("rejects malformed paired-node data and cursors before forwarding", async () => {
    const invoke = vi.fn();
    const { provider: catalog } = capturePairedNodeCatalog(
      [pairedNode([OPENCODE_SESSIONS_LIST_COMMAND, OPENCODE_SESSION_READ_COMMAND])],
      invoke,
    );
    for (const threadId of [123, "--help"]) {
      invoke.mockResolvedValueOnce(pairedNodeSessionPage(pairedNodeSession({ threadId })));
      await expectPairedNodeListError(catalog!);
    }

    invoke.mockResolvedValueOnce(
      nodePayload({
        threadId: "ses_remote",
        items: [{ type: "invalid", text: "bad" }],
      }),
    );
    await expect(readPairedNode(catalog!)).rejects.toThrow("invalid transcript page");

    invoke.mockClear();
    await expect(readPairedNode(catalog!, { cursor: "" })).rejects.toThrow("cursor is invalid");
    await expectPairedNodeListError(catalog!, { cursors: { "node:node-1": "" } });
    expect(invoke).not.toHaveBeenCalled();

    invoke.mockResolvedValueOnce(nodePayload({ sessions: [], nextCursor: " wrapped " }));
    await expectPairedNodeListError(catalog!);
    invoke.mockResolvedValueOnce(
      nodePayload({ threadId: "ses_remote", items: [], nextCursor: " wrapped " }),
    );
    await expect(readPairedNode(catalog!)).rejects.toThrow("invalid cursor");

    const exactCursor = Buffer.from(JSON.stringify({ offset: 1 }), "utf8").toString("base64url");
    invoke.mockResolvedValueOnce(nodePayload({ sessions: [] }));
    await listPairedNode(catalog!, { cursors: { "node:node-1": exactCursor } });
    expect(invoke).toHaveBeenLastCalledWith(
      expect.objectContaining({ params: { cursor: exactCursor } }),
    );
    invoke.mockResolvedValueOnce(nodePayload({ threadId: "ses_remote", items: [] }));
    await readPairedNode(catalog!, { cursor: exactCursor });
    expect(invoke).toHaveBeenLastCalledWith(
      expect.objectContaining({ params: { threadId: "ses_remote", cursor: exactCursor } }),
    );
  });

  it("maps a shared-runtime pipe failure to the OpenCode-owned error", async () => {
    runCommand.mockResolvedValueOnce({
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
      code: null,
      signal: null,
      killed: true,
      termination: "error",
      errorStream: "stderr",
      error: new Error("stderr EPIPE"),
    });

    await expectRejects(
      listLocalOpenCodeSessionPage({ limit: 20 }),
      "OpenCode stderr stream failed: stderr EPIPE",
    );
    expect(runCommand).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({ terminateOnOutputError: true }),
    );
  });
});
