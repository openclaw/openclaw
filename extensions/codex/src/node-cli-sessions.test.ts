import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import {
  fixtureReceiptClientSource,
  openFixtureReceiptChannel,
  type FixtureReceiptChannel,
  withinTest,
} from "openclaw/plugin-sdk/test-fixtures";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { commandResult } from "../../test-support/command-result.test-support.js";
import manifest from "../openclaw.plugin.json" with { type: "json" };
import {
  createCodexCliSessionNodeHostCommands,
  createCodexCliSessionNodeInvokePolicies,
  CODEX_CLI_SESSION_SOURCE_CAPABILITY,
  listCodexCliSessionsOnNode as listNode,
  resumeCodexCliSessionOnNode as resumeNode,
} from "./node-cli-sessions.js";
import { codexCatalogHomeId } from "./session-catalog-home-id.js";

const LIST = "codex.cli.sessions.list";

type RunCommandBuffered =
  (typeof import("openclaw/plugin-sdk/process-runtime"))["runCommandBuffered"];
const runCommand = vi.hoisted(() => vi.fn<RunCommandBuffered>());

vi.mock("openclaw/plugin-sdk/process-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/process-runtime")>()),
  runCommandBuffered: runCommand,
}));

let tempDir: string;
const resolveCatalogSource = vi.fn<Parameters<typeof createCodexCliSessionNodeHostCommands>[0]>();
let receipts: FixtureReceiptChannel;

beforeAll(async () => {
  receipts = await openFixtureReceiptChannel();
});
afterAll(() => receipts.close());

async function completeResume(argv: string[]) {
  const outputFlag = argv.indexOf("--output-last-message");
  const outputPath = argv[outputFlag + 1];
  if (outputFlag < 0 || !outputPath) {
    throw new Error("missing Codex output path");
  }
  await fs.writeFile(outputPath, "final answer\n");
  return {
    ...commandResult(),
    stdout: Buffer.alloc(0),
    stderr: Buffer.alloc(0),
    termination: "exit" as const,
  };
}

async function listLocalSessions(params: { filter?: string; limit?: number }) {
  const raw = await nodeCommand(LIST).handle(JSON.stringify(params));
  return JSON.parse(raw ?? "{}") as Awaited<ReturnType<typeof listNode>>["result"];
}

function resumeRequest(
  sessionId: string,
  overrides: Partial<Parameters<typeof resumeNode>[0]> = {},
) {
  return JSON.stringify({ sessionId, prompt: "continue", ...overrides });
}

function summary(
  sessionId: string,
  sessionFile: string,
  cwd: string,
  lastMessage: string,
  updatedAt = "2026-05-14T00:10:24.000Z",
) {
  return { sessionId, sessionFile, cwd, lastMessage, updatedAt, messageCount: 1 };
}

async function scriptProcess(scriptArgs: string[]): Promise<RunCommandBuffered> {
  const { runCommandBuffered } = await vi.importActual<
    typeof import("openclaw/plugin-sdk/process-runtime")
  >("openclaw/plugin-sdk/process-runtime");
  return (argv, options) =>
    runCommandBuffered(
      [process.execPath, ...scriptArgs, argv[argv.indexOf("--output-last-message") + 1]!],
      options,
    );
}

function nodeCommand(
  name = "codex.cli.session.resume",
  source: Parameters<typeof createCodexCliSessionNodeHostCommands>[0] = resolveCatalogSource,
) {
  return createCodexCliSessionNodeHostCommands(source).find((entry) => entry.command === name)!;
}

async function writeHistory(records: Array<{ session_id: string; ts: number; text: string }>) {
  await fs.writeFile(
    path.join(tempDir, "history.jsonl"),
    records.map((record) => JSON.stringify(record)).join("\n"),
  );
}

const meta = (id: string, cwd: string, timestamp = "2026-05-14T00:10:23.618Z") => ({
  timestamp,
  type: "session_meta",
  payload: { id, cwd },
});
const userMessage = (text: string, timestamp = "2026-05-14T00:10:24.000Z") => ({
  timestamp,
  type: "response_item",
  payload: { type: "message", role: "user", content: [{ type: "input_text", text }] },
});

async function writeRollout(sessionId: string, records: unknown[] = [], large = false) {
  const sessionDir = path.join(tempDir, "sessions", "2026", "05", "14");
  const sessionFile = path.join(sessionDir, `rollout-2026-05-14T00-10-22-${sessionId}.jsonl`);
  await fs.mkdir(sessionDir, { recursive: true });
  await fs.writeFile(sessionFile, records.map((record) => JSON.stringify(record)).join("\n"));
  if (large) {
    await fs.truncate(sessionFile, 5 * 1_024 * 1_024);
  }
  return sessionFile;
}

type SessionEntry = ReturnType<PluginRuntime["agent"]["session"]["getSessionEntry"]>;
function catalogEntry(sourceHomeId: string, changed = ""): NonNullable<SessionEntry> {
  const marker = {
    sourceHostId: "node:node-1",
    sourceThreadId: changed === "thread" ? "other-thread" : "native-thread",
    nodeId: changed === "node" ? "other-node" : "node-1",
    sourceHomeId,
    ...(changed === "initializing" ? { initializing: true } : {}),
  };
  return {
    sessionId: "openclaw-session",
    updatedAt: 1,
    agentHarnessId: "codex",
    modelSelectionLocked: changed !== "lock",
    pluginExtensions:
      changed === "missing marker" ? undefined : { codex: { sessionCatalog: marker } },
  };
}
function catalogRequest(runtime: PluginRuntime) {
  return {
    runtime,
    nodeId: "node-1",
    sessionId: "native-thread",
    sessionKey: "agent:research:harness:codex:node-session:catalog-chat",
    agentId: "research",
    prompt: "continue",
  };
}
async function createCatalog(homeScope: "agent" | "user" = "agent") {
  const { createCodexSessionCatalogControl } = await import("./session-catalog-control.js");
  const { resolveCodexSupervisionAppServerRuntimeOptions } = await import("./app-server/config.js");
  let config: OpenClawConfig =
    homeScope === "agent" ? { agents: { ownership: "explicit", entries: { research: {} } } } : {};
  let pluginConfig = { appServer: { transport: "stdio", homeScope } };
  const factory = createCodexSessionCatalogControl({
    config,
    getRuntimeConfig: () => config,
    getPluginConfig: () => pluginConfig,
    resolveRuntimeOptions: resolveCodexSupervisionAppServerRuntimeOptions,
  });
  return {
    factory,
    reconfigure: (transport: string, nextConfig: OpenClawConfig = { ...config }) => {
      pluginConfig = {
        appServer: { transport, homeScope: transport === "stdio" ? homeScope : "user" },
      };
      config = nextConfig;
    },
  };
}

beforeEach(async () => {
  runCommand.mockReset().mockImplementation(completeResume);
  resolveCatalogSource.mockReset();
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-cli-sessions-"));
  vi.stubEnv("CODEX_HOME", tempDir);
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await fs.rm(tempDir, { recursive: true, force: true });
});

it.each([true, false])("guards selected-home resume capability %s", async (sourceAware) => {
  const policy = createCodexCliSessionNodeInvokePolicies().find((entry) =>
    entry.commands.includes("codex.cli.session.resume"),
  )!;
  const invokeNode = vi.fn(async () => ({ ok: true as const, payload: { text: "done" } }));
  const result = await policy.handle({
    nodeId: "node-1",
    command: "codex.cli.session.resume",
    params: {
      sessionId: "native-thread",
      prompt: "continue",
      sourceHomeId: codexCatalogHomeId(tempDir),
    },
    config: {},
    node: { nodeId: "node-1", caps: sourceAware ? [CODEX_CLI_SESSION_SOURCE_CAPABILITY] : [] },
    invokeNode,
  });
  expect(result.ok).toBe(sourceAware);
  if (sourceAware) {
    expect(invokeNode).toHaveBeenCalledOnce();
  } else {
    expect(result).toMatchObject({
      code: "CODEX_NODE_SOURCE_UNAVAILABLE",
      message: expect.stringContaining("Update the node"),
    });
    expect(invokeNode).not.toHaveBeenCalled();
  }
});

it.each(["legacy", "catalog-user"] as const)(
  "anchors relative CODEX_HOME for %s commands",
  async (route) => {
    const codexHome = await fs.mkdtemp(path.join(process.cwd(), ".codex-node-relative-home-"));
    const relativeHome = path.relative(process.cwd(), codexHome);
    const project = path.join(tempDir, "project");
    await fs.mkdir(project);
    vi.stubEnv("CODEX_HOME", relativeHome);
    const { factory } = await createCatalog("user");
    try {
      await fs.writeFile(
        path.join(codexHome, "history.jsonl"),
        JSON.stringify({
          session_id: "relative-home-session",
          ts: 1778678322,
          text: "relative home receipt",
        }),
      );
      const resume = nodeCommand(undefined, (agentId) => factory.forNode(agentId));
      const listed = JSON.parse(await nodeCommand(LIST).handle());
      expect(listed.sessions).toMatchObject([
        { sessionId: "relative-home-session", lastMessage: "relative home receipt" },
      ]);
      runCommand.mockImplementation(
        await scriptProcess([
          "-e",
          `const fs = require("node:fs");
         const path = require("node:path");
         process.stdin.resume();
         const history = JSON.parse(fs.readFileSync(path.join(process.env.CODEX_HOME, "history.jsonl"), "utf8"));
         fs.writeFileSync(process.argv[1], history.text);`,
        ]),
      );
      const resumed = JSON.parse(
        await resume.handle(
          resumeRequest("relative-home-session", {
            cwd: project,
            ...(route === "catalog-user" ? { agentId: "gateway-only" } : {}),
          }),
        ),
      );
      expect(resumed).toMatchObject({ ok: true, text: listed.sessions[0].lastMessage });
      expect(runCommand).toHaveBeenCalledWith(
        expect.any(Array),
        expect.objectContaining({ cwd: project }),
      );
    } finally {
      await factory.stop();
      await fs.rm(codexHome, { recursive: true, force: true });
    }
  },
);

it("keeps authorized resume execution available while native discovery is disabled", async () => {
  runCommand.mockImplementation(async (argv) => ({
    ...(await completeResume(argv)),
    stdout: Buffer.from("diagnostic"),
  }));

  vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(tempDir, "openclaw.json"));
  vi.stubEnv("OPENCLAW_STATE_DIR", tempDir);
  const { createPluginRegistry, createPluginRecord } =
    await import("openclaw/plugin-sdk/plugin-test-runtime");
  const config = {
    plugins: {
      entries: { codex: { enabled: true, config: { sessionCatalog: { enabled: false } } } },
    },
  };
  const registry = createPluginRegistry({
    runtime: createPluginRuntimeMock({ config: { current: () => config } }),
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    activateGlobalSideEffects: false,
  });
  const record = createPluginRecord({
    id: manifest.id,
    source: path.join(tempDir, "index.js"),
    nativeSessionCatalog: manifest.setup.nativeSessionCatalog,
  });
  registry.registry.plugins.push(record);
  const api = registry.createApi(record, { config });
  for (const command of createCodexCliSessionNodeHostCommands(resolveCatalogSource)) {
    api.registerNodeHostCommand(command);
  }
  for (const policy of createCodexCliSessionNodeInvokePolicies()) {
    api.registerNodeInvokePolicy(policy);
  }
  const commands = registry.registry.nodeHostCommands.map((entry) => entry.command);
  const list = commands.find((entry) => entry.command === LIST);
  const command = commands.find((entry) => entry.command === "codex.cli.session.resume");
  if (!list || !command) {
    throw new Error("Codex node commands did not register");
  }
  await expect(list.handle()).rejects.toThrow("discovery is disabled");
  expect(command.dangerous).toBe(true);
  expect(
    registry.registry.nodeInvokePolicies.find((entry) =>
      entry.policy.commands.includes(command.command),
    )?.policy.dangerous,
  ).toBe(true);
  const raw = await command.handle(
    resumeRequest("session-123", {
      prompt: "continue this task",
      cwd: tempDir,
      timeoutMs: 12_345,
    }),
  );

  expect(JSON.parse(raw ?? "{}")).toEqual({
    ok: true,
    sessionId: "session-123",
    text: "final answer",
  });
  const [argv, options] = runCommand.mock.calls[0] ?? [];
  const execIndex = argv?.indexOf("exec") ?? -1;
  expect(argv?.slice(execIndex, execIndex + 7)).toEqual([
    "exec",
    "resume",
    "--skip-git-repo-check",
    "--output-last-message",
    expect.any(String),
    "session-123",
    "-",
  ]);
  expect(options).toMatchObject({
    cwd: tempDir,
    input: "continue this task",
    killGraceMs: 2_000,
    terminateOnOutputError: true,
    timeoutMs: 12_345,
  });
});

it.each([
  { scenario: "hydrated cwd", text: "latest ask", ts: 1778678322 },
  { scenario: "empty rollout", text: "history prompt", ts: 1778678322 },
  { scenario: "Date-invalid timestamp", text: "bad timestamp", ts: 8_700_000_000_000 },
])("keeps history usable with $scenario", async ({ scenario, text, ts }) => {
  const sessionId = "019e2007-1f7e-7eb1-a42b-8c01f4b9b5cd";
  const hydrated = scenario === "hydrated cwd";
  const records = [{ session_id: sessionId, ts, text }];
  let sessionFile: string | undefined;
  if (hydrated) {
    records.unshift({ session_id: sessionId, ts: 1778677925, text: "first ask" });
    records.push({ session_id: "older", ts: 1778670000, text: "skip me" });
    sessionFile = await writeRollout(sessionId, [
      { type: "session_meta", payload: { id: sessionId, cwd: "/repo" } },
    ]);
  }
  await writeHistory(records);
  if (scenario === "empty rollout") {
    const sessionsDir = path.join(tempDir, "sessions");
    await fs.mkdir(sessionsDir);
    await fs.writeFile(path.join(sessionsDir, `rollout-${sessionId}.jsonl`), "");
  }
  const parsed = await listLocalSessions({
    filter: scenario === "empty rollout" ? sessionId : hydrated ? "latest" : text,
    limit: 5,
  });
  expect(parsed.sessions).toEqual([
    {
      sessionId,
      lastMessage: text,
      messageCount: hydrated ? 2 : 1,
      ...(scenario === "Date-invalid timestamp" ? {} : { updatedAt: "2026-05-13T13:18:42.000Z" }),
      ...(hydrated ? { sessionFile, cwd: "/repo" } : {}),
    },
  ]);
});

it("cancels running resume and releases its reservation", async ({ signal }) => {
  const ready = path.join(tempDir, "ready");
  const lateWrite = path.join(tempDir, "late-write");
  runCommand.mockImplementationOnce(
    await scriptProcess([
      "--input-type=module",
      "-e",
      `${fixtureReceiptClientSource(receipts.endpoint)}
           import fs from "node:fs";
           fs.writeFileSync(process.argv[1], "ready");
           sendReceipt(process.argv[1], "ready");
           setTimeout(() => {
             fs.writeFileSync(process.argv[2], "unexpected write");
             fs.writeFileSync(process.argv[3], "late reply");
           }, 1_000);`,
      ready,
      lateWrite,
    ]),
  );
  const command = nodeCommand();
  const request = resumeRequest("canceled-session", { cwd: tempDir });
  const controller = new AbortController();
  const result = command.handle(request, undefined, {
    signal: controller.signal,
    sendNodeEvent: async () => undefined,
  });
  // Receipts and command settlement are unordered; the file is written before either.
  const readyAfterSettlement = result.then(
    async () => expect(await fs.readFile(ready, "utf8")).toBe("ready"),
    async (error: unknown) => {
      if ((await fs.readFile(ready, "utf8").catch(() => "")) !== "ready") {
        throw error;
      }
    },
  );
  try {
    await withinTest(
      Promise.race([receipts.waitFor(ready, "ready"), readyAfterSettlement]),
      signal,
    );
    controller.abort(new Error("node invocation canceled"));
    await expect(result).rejects.toThrow("node invocation canceled");
    await expect(fs.stat(lateWrite)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(command.handle(request)).resolves.toContain("final answer");
  } finally {
    controller.abort(new Error("node invocation canceled"));
    await result.catch(() => undefined);
  }
});

it("does not start a node resume canceled while its source is resolving", async () => {
  const source = Promise.withResolvers<Awaited<ReturnType<typeof resolveCatalogSource>>>();
  resolveCatalogSource.mockReturnValueOnce(source.promise);
  const controller = new AbortController();
  const result = nodeCommand().handle(
    resumeRequest("pending-session", { agentId: "research" }),
    undefined,
    { signal: controller.signal, sendNodeEvent: async () => undefined },
  );
  const rejected = expect(result).rejects.toThrow("node invocation canceled");
  controller.abort(new Error("node invocation canceled"));
  source.resolve({
    codexHome: tempDir,
    sourceHomeId: codexCatalogHomeId(tempDir),
    transport: "stdio",
    assertCurrent: () => {},
  });
  await rejected;
  expect(runCommand).not.toHaveBeenCalled();
});

it("preserves the node-owned catalog home and rejects an unavailable source", async () => {
  vi.stubEnv("OPENCLAW_STATE_DIR", tempDir);
  const { factory, reconfigure } = await createCatalog();
  try {
    const source = await factory.forNode("research");
    expect(source.codexHome).not.toBe(tempDir);
    await fs.mkdir(source.codexHome, { recursive: true });
    runCommand.mockImplementation(async (argv, options) => {
      await fs.writeFile(path.join(options?.env?.CODEX_HOME ?? tempDir, "resumed"), "yes");
      return completeResume(argv);
    });
    const command = nodeCommand(undefined, (agentId) => factory.forNode(agentId));
    const entry = catalogEntry(source.sourceHomeId);
    const invoke = vi.fn<PluginRuntime["nodes"]["invoke"]>(async (request) => ({
      ok: true,
      payloadJSON: await command.handle(JSON.stringify(request.params)),
    }));
    const runtime = createPluginRuntimeMock({
      agent: { session: { getSessionEntryAsync: async () => entry } },
      nodes: { invoke },
    });
    const request = { ...catalogRequest(runtime), cwd: tempDir };
    await expect(resumeNode(request)).resolves.toMatchObject({
      text: "final answer",
    });
    expect(await fs.readFile(path.join(source.codexHome, "resumed"), "utf8")).toBe("yes");
    await expect(fs.stat(path.join(tempDir, "resumed"))).rejects.toMatchObject({
      code: "ENOENT",
    });

    reconfigure("unix");
    await expect(resumeNode(request)).rejects.toThrow("requires a local Codex catalog source");
    reconfigure("unix", { agents: { ownership: "explicit", entries: { replacement: {} } } });
    await expect(resumeNode(request)).rejects.toThrow("unknown Codex session catalog agent");
  } finally {
    await factory.stop();
  }
});

it("revalidates the node source after awaited CLI temporary-directory setup", async () => {
  vi.stubEnv("OPENCLAW_STATE_DIR", tempDir);
  const { factory, reconfigure } = await createCatalog();
  const allocated = Promise.withResolvers<string>();
  const releaseAllocation = Promise.withResolvers<void>();
  const createTemporaryDirectory = fs.mkdtemp.bind(fs);
  const allocate = vi.spyOn(fs, "mkdtemp").mockImplementationOnce(async (prefix, options) => {
    const directory = await createTemporaryDirectory(prefix, options);
    allocated.resolve(directory);
    await releaseAllocation.promise;
    return directory;
  });
  const command = nodeCommand(undefined, (agentId) => factory.forNode(agentId));
  const request = resumeRequest("source-race", { agentId: "research", cwd: tempDir });
  let running: Promise<string> | undefined;
  try {
    running = command.handle(request);
    const rejected = expect(running).rejects.toThrow("configuration changed");
    const directory = await allocated.promise;
    reconfigure("unix");
    releaseAllocation.resolve();
    await rejected;
    expect(runCommand).not.toHaveBeenCalled();
    await expect(fs.stat(directory)).rejects.toMatchObject({ code: "ENOENT" });
    allocate.mockRestore();
    reconfigure("stdio");
    await expect(command.handle(request)).resolves.toContain("final answer");
  } finally {
    releaseAllocation.resolve();
    await running?.catch(() => undefined);
    allocate.mockRestore();
    await factory.stop();
  }
});

it.each(["thread", "node", "lock", "initializing", "missing row", "missing marker"])(
  "rejects a catalog binding whose %s changed before node execution",
  async (changed) => {
    const invoke = vi.fn<PluginRuntime["nodes"]["invoke"]>();
    const entry =
      changed === "missing row" ? undefined : catalogEntry(codexCatalogHomeId(tempDir), changed);
    const runtime = createPluginRuntimeMock({
      agent: { session: { getSessionEntryAsync: async () => entry } },
      nodes: { invoke },
    });
    await expect(resumeNode(catalogRequest(runtime))).rejects.toThrow(
      "changed before its node turn",
    );
    expect(invoke).not.toHaveBeenCalled();
  },
);

it("streams many-chunk records and truncates previews at UTF-16 boundaries", async () => {
  const prefix = "b".repeat(136);
  const sessionId = "019e23d1-f33d-78e3-959e-0f56f30a5250";
  const cwd = "/tmp/codex-work";
  const sessionFile = await writeRollout(sessionId, [
    meta(sessionId, cwd),
    { type: "event_msg", payload: { type: "token_count", padding: "x".repeat(5 * 1_024 * 1_024) } },
    userMessage(`${prefix}🤖tail`),
  ]);
  const readFile = vi.spyOn(fs, "readFile");
  const parsed = await listLocalSessions({ limit: 5 });
  expect(readFile).not.toHaveBeenCalledWith(sessionFile, "utf8");
  expect(parsed.sessions).toEqual([summary(sessionId, sessionFile, cwd, `${prefix}...`)]);
});

it.each(["read", "close"] as const)("handles a large-file %s failure", async (failure) => {
  const partial = failure === "read";
  const sessionId = partial
    ? "019e23d1-f33d-78e3-959e-0f56f30a5251"
    : "019e23d1-f33d-78e3-959e-0f56f30a5252";
  const cwd = partial ? "/tmp/partial" : "/tmp/close-failure";
  const sessionFile = await writeRollout(sessionId, [], true);
  const content = Buffer.from(
    [
      JSON.stringify(meta(sessionId, cwd)),
      ...(partial ? [] : [JSON.stringify(userMessage("survives close failure"))]),
    ].join("\n") + (partial ? "\n" : ""),
  );
  const ioError = Object.assign(new Error(`${failure} failed`), { code: "EIO" });
  const close = vi.fn(async () => {
    if (!partial) {
      throw ioError;
    }
  });
  const read = vi.fn().mockImplementationOnce(async (buffer: Buffer) => {
    content.copy(buffer);
    return { bytesRead: content.length, buffer };
  });
  if (partial) {
    read.mockRejectedValueOnce(ioError);
  } else {
    read.mockResolvedValueOnce({ bytesRead: 0, buffer: Buffer.alloc(0) });
  }
  vi.spyOn(fs, "open").mockResolvedValue({ read, close } as never);
  const parsed = await listLocalSessions({ limit: 5 });
  expect(parsed.sessions).toEqual(
    partial ? [] : [summary(sessionId, sessionFile, cwd, "survives close failure")],
  );
  expect(close).toHaveBeenCalledOnce();
});

it("reports malformed node session payloadJSON with an owned error", async () => {
  const invoke = vi.fn(async () => ({ ok: true, payloadJSON: "{not json" }));
  const runtime = {
    nodes: {
      list: vi.fn(async () => ({
        nodes: [{ nodeId: "node-1", connected: true, commands: [LIST] }],
      })),
      invoke,
    },
  } as unknown as PluginRuntime;

  await expect(listNode({ runtime, requestedNode: "node-1" })).rejects.toThrow(
    "Codex CLI node command returned malformed payloadJSON.",
  );
  expect(invoke).toHaveBeenCalledWith(expect.objectContaining({ scopes: ["operator.write"] }));
});
