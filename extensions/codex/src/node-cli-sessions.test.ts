// Codex tests cover node cli sessions plugin behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import manifest from "../openclaw.plugin.json" with { type: "json" };
import {
  createCodexCliSessionNodeHostCommands,
  createCodexCliSessionNodeInvokePolicies,
  CODEX_CLI_SESSION_SOURCE_CAPABILITY,
  listCodexCliSessionsOnNode,
  resumeCodexCliSessionOnNode,
} from "./node-cli-sessions.js";
import { codexCatalogHomeId } from "./session-catalog-home-id.js";

const CODEX_CLI_SESSIONS_LIST_COMMAND = "codex.cli.sessions.list";

type RunCommandBuffered =
  (typeof import("openclaw/plugin-sdk/process-runtime"))["runCommandBuffered"];
const processRuntimeMocks = vi.hoisted(() => ({
  runCommandBuffered: vi.fn<RunCommandBuffered>(),
}));

vi.mock("openclaw/plugin-sdk/process-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/process-runtime")>()),
  runCommandBuffered: processRuntimeMocks.runCommandBuffered,
}));

let tempDir: string;
let previousCodexHome: string | undefined;
const resolveCatalogSource = vi.fn<Parameters<typeof createCodexCliSessionNodeHostCommands>[0]>();

async function completeResume(argv: string[]) {
  const outputPath = argv[argv.indexOf("--output-last-message") + 1];
  if (!outputPath) {
    throw new Error("missing Codex output path");
  }
  await fs.writeFile(outputPath, "final answer\n");
  return {
    stdout: Buffer.alloc(0),
    stderr: Buffer.alloc(0),
    code: 0,
    signal: null,
    killed: false,
    termination: "exit" as const,
  };
}

describe("codex cli node sessions", () => {
  beforeEach(async () => {
    processRuntimeMocks.runCommandBuffered.mockReset().mockImplementation(completeResume);
    resolveCatalogSource.mockReset();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-cli-sessions-"));
    previousCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = tempDir;
  });

  afterEach(async () => {
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it.each([
    { sourceAware: false, catalogAgent: undefined, sourcePin: false, allowed: true },
    { sourceAware: true, catalogAgent: "research", sourcePin: false, allowed: true },
    { sourceAware: false, catalogAgent: "research", sourcePin: false, allowed: false },
    { sourceAware: true, catalogAgent: undefined, sourcePin: true, allowed: true },
    { sourceAware: false, catalogAgent: undefined, sourcePin: true, allowed: false },
  ])(
    "guards selected-home resume for node capability $sourceAware, agent $catalogAgent and source pin $sourcePin",
    async ({ sourceAware, catalogAgent, sourcePin, allowed }) => {
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
          ...(catalogAgent ? { agentId: catalogAgent } : {}),
          ...(sourcePin ? { sourceHomeId: codexCatalogHomeId(tempDir) } : {}),
        },
        config: {},
        node: { nodeId: "node-1", caps: sourceAware ? [CODEX_CLI_SESSION_SOURCE_CAPABILITY] : [] },
        invokeNode,
      });
      expect(result.ok).toBe(allowed);
      if (allowed) {
        expect(invokeNode).toHaveBeenCalledOnce();
      } else {
        expect(result).toMatchObject({
          code: "CODEX_NODE_SOURCE_UNAVAILABLE",
          message: expect.stringContaining("Update the node"),
        });
        expect(invokeNode).not.toHaveBeenCalled();
      }
    },
  );

  it("lists recent sessions from Codex history and hydrates cwd from session files", async () => {
    const sessionId = "019e2007-1f7e-7eb1-a42b-8c01f4b9b5cd";
    await fs.writeFile(
      path.join(tempDir, "history.jsonl"),
      [
        JSON.stringify({ session_id: sessionId, ts: 1778677925, text: "first ask" }),
        JSON.stringify({ session_id: sessionId, ts: 1778678322, text: "latest ask" }),
        JSON.stringify({ session_id: "older", ts: 1778670000, text: "skip me" }),
      ].join("\n"),
    );
    const sessionDir = path.join(tempDir, "sessions", "2026", "05", "13");
    await fs.mkdir(sessionDir, { recursive: true });
    await fs.writeFile(
      path.join(sessionDir, `rollout-2026-05-13T08-29-58-${sessionId}.jsonl`),
      `${JSON.stringify({
        type: "session_meta",
        payload: { id: sessionId, cwd: "/repo" },
      })}\n`,
    );

    const command = createCodexCliSessionNodeHostCommands(resolveCatalogSource).find(
      (entry) => entry.command === CODEX_CLI_SESSIONS_LIST_COMMAND,
    );
    const raw = await command?.handle(JSON.stringify({ filter: "latest", limit: 5 }));
    const parsed = JSON.parse(raw ?? "{}") as {
      sessions?: Array<{
        sessionId?: string;
        cwd?: string;
        lastMessage?: string;
        messageCount?: number;
      }>;
    };

    expect(parsed.sessions).toEqual([
      {
        sessionId,
        updatedAt: "2026-05-13T13:18:42.000Z",
        lastMessage: "latest ask",
        cwd: "/repo",
        sessionFile: path.join(sessionDir, `rollout-2026-05-13T08-29-58-${sessionId}.jsonl`),
        messageCount: 2,
      },
    ]);
  });

  it.each(["legacy", "catalog-user"] as const)(
    "keeps relative CODEX_HOME anchored to the node for %s list and resume",
    async (route) => {
      const codexHome = await fs.mkdtemp(path.join(process.cwd(), ".codex-node-relative-home-"));
      const relativeHome = path.relative(process.cwd(), codexHome);
      const project = path.join(tempDir, "project");
      await fs.mkdir(project);
      vi.stubEnv("CODEX_HOME", relativeHome);
      const { createCodexSessionCatalogControl } = await import("./session-catalog-control.js");
      const { resolveCodexSupervisionAppServerRuntimeOptions } =
        await import("./app-server/config.js");
      const config: OpenClawConfig = {};
      const factory = createCodexSessionCatalogControl({
        config,
        getRuntimeConfig: () => config,
        getPluginConfig: () => ({ appServer: { transport: "stdio", homeScope: "user" } }),
        resolveRuntimeOptions: resolveCodexSupervisionAppServerRuntimeOptions,
      });
      try {
        expect(path.isAbsolute(relativeHome)).toBe(false);
        await fs.writeFile(
          path.join(codexHome, "history.jsonl"),
          JSON.stringify({
            session_id: "relative-home-session",
            ts: 1778678322,
            text: "relative home receipt",
          }),
        );
        const commands = createCodexCliSessionNodeHostCommands((agentId) =>
          factory.forNode(agentId),
        );
        const list = commands.find(
          (command) => command.command === CODEX_CLI_SESSIONS_LIST_COMMAND,
        )!;
        const resume = commands.find((command) => command.command === "codex.cli.session.resume")!;
        const listed = JSON.parse(await list.handle());
        expect(listed.sessions).toMatchObject([
          { sessionId: "relative-home-session", lastMessage: "relative home receipt" },
        ]);
        const { runCommandBuffered } = await vi.importActual<
          typeof import("openclaw/plugin-sdk/process-runtime")
        >("openclaw/plugin-sdk/process-runtime");
        processRuntimeMocks.runCommandBuffered.mockImplementation((argv, options) =>
          runCommandBuffered(
            [
              process.execPath,
              "-e",
              `const fs = require("node:fs");
         const path = require("node:path");
         process.stdin.resume();
         const history = JSON.parse(fs.readFileSync(path.join(process.env.CODEX_HOME, "history.jsonl"), "utf8"));
         fs.writeFileSync(process.argv[1], history.text);`,
              argv[argv.indexOf("--output-last-message") + 1]!,
            ],
            options,
          ),
        );
        const resumed = JSON.parse(
          await resume.handle(
            JSON.stringify({
              sessionId: "relative-home-session",
              prompt: "continue",
              cwd: project,
              ...(route === "catalog-user" ? { agentId: "gateway-only" } : {}),
            }),
          ),
        );
        expect(resumed).toMatchObject({ ok: true, text: listed.sessions[0].lastMessage });
        expect(processRuntimeMocks.runCommandBuffered).toHaveBeenCalledWith(
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
    processRuntimeMocks.runCommandBuffered.mockImplementation(async (argv) => {
      const outputFlag = argv.indexOf("--output-last-message");
      const outputPath = argv[outputFlag + 1];
      if (outputFlag < 0 || !outputPath) {
        throw new Error("missing Codex output path");
      }
      await fs.writeFile(outputPath, "final answer\n", "utf8");
      return {
        stdout: Buffer.from("diagnostic"),
        stderr: Buffer.alloc(0),
        code: 0,
        signal: null,
        killed: false,
        termination: "exit",
      };
    });

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
    for (const nodeCommand of createCodexCliSessionNodeHostCommands(resolveCatalogSource)) {
      api.registerNodeHostCommand(nodeCommand);
    }
    for (const policy of createCodexCliSessionNodeInvokePolicies()) {
      api.registerNodeInvokePolicy(policy);
    }
    const commands = registry.registry.nodeHostCommands.map((entry) => entry.command);
    const list = commands.find((entry) => entry.command === CODEX_CLI_SESSIONS_LIST_COMMAND);
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
      JSON.stringify({
        sessionId: "session-123",
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
    const [argv, options] = processRuntimeMocks.runCommandBuffered.mock.calls[0] ?? [];
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

  it.each(["empty", "different session"])(
    "does not attach an %s rollout to history from its filename alone",
    async (contents) => {
      const sessionId = "019e2007-1f7e-7eb1-a42b-8c01f4b9b5cd";
      await fs.writeFile(
        path.join(tempDir, "history.jsonl"),
        JSON.stringify({ session_id: sessionId, ts: 1778678322, text: "history prompt" }),
      );
      const sessionsDir = path.join(tempDir, "sessions");
      await fs.mkdir(sessionsDir);
      await fs.writeFile(
        path.join(sessionsDir, `rollout-${sessionId}.jsonl`),
        contents === "empty"
          ? ""
          : JSON.stringify({
              type: "session_meta",
              payload: { id: "another-session", cwd: "/different-project" },
            }),
      );
      const command = createCodexCliSessionNodeHostCommands(resolveCatalogSource).find(
        (entry) => entry.command === CODEX_CLI_SESSIONS_LIST_COMMAND,
      )!;
      const result = JSON.parse(await command.handle(JSON.stringify({ filter: sessionId })));
      expect(result.sessions).toEqual([
        {
          sessionId,
          updatedAt: "2026-05-13T13:18:42.000Z",
          lastMessage: "history prompt",
          messageCount: 1,
        },
      ]);
    },
  );

  it("cancels a running node resume before a delayed write and releases its reservation", async () => {
    const { runCommandBuffered } = await vi.importActual<
      typeof import("openclaw/plugin-sdk/process-runtime")
    >("openclaw/plugin-sdk/process-runtime");
    const ready = path.join(tempDir, "ready");
    const lateWrite = path.join(tempDir, "late-write");
    processRuntimeMocks.runCommandBuffered.mockImplementationOnce((argv, options) =>
      runCommandBuffered(
        [
          process.execPath,
          "-e",
          `const fs = require("node:fs");
           fs.writeFileSync(process.argv[1], "ready");
           setTimeout(() => {
             fs.writeFileSync(process.argv[2], "unexpected write");
             fs.writeFileSync(process.argv[3], "late reply");
           }, 1_000);`,
          ready,
          lateWrite,
          argv[argv.indexOf("--output-last-message") + 1]!,
        ],
        options,
      ),
    );
    const command = createCodexCliSessionNodeHostCommands(resolveCatalogSource).find(
      (entry) => entry.command === "codex.cli.session.resume",
    )!;
    const request = JSON.stringify({
      sessionId: "canceled-session",
      prompt: "continue",
      cwd: tempDir,
    });
    const controller = new AbortController();
    const result = command.handle(request, undefined, {
      signal: controller.signal,
      sendNodeEvent: async () => undefined,
    });
    const rejected = expect(result).rejects.toThrow("node invocation canceled");
    await vi.waitFor(async () => expect(await fs.readFile(ready, "utf8")).toBe("ready"));
    controller.abort(new Error("node invocation canceled"));
    await rejected;
    await expect(fs.stat(lateWrite)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(command.handle(request)).resolves.toContain("final answer");
  });

  it("does not start a node resume canceled while its source is resolving", async () => {
    const source = createDeferred<Awaited<ReturnType<typeof resolveCatalogSource>>>();
    resolveCatalogSource.mockReturnValueOnce(source.promise);
    const command = createCodexCliSessionNodeHostCommands(resolveCatalogSource).find(
      (entry) => entry.command === "codex.cli.session.resume",
    )!;
    const controller = new AbortController();
    const result = command.handle(
      JSON.stringify({ sessionId: "pending-session", agentId: "research", prompt: "continue" }),
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
    expect(processRuntimeMocks.runCommandBuffered).not.toHaveBeenCalled();
  });

  it("preserves the node-owned catalog home without redirecting legacy bindings", async () => {
    const { createCodexSessionCatalogControl } = await import("./session-catalog-control.js");
    const { resolveCodexSupervisionAppServerRuntimeOptions } =
      await import("./app-server/config.js");
    vi.stubEnv("OPENCLAW_STATE_DIR", tempDir);
    let config: OpenClawConfig = {
      agents: { ownership: "explicit", entries: { research: {} } },
    };
    let pluginConfig = { appServer: { transport: "stdio", homeScope: "agent" } };
    const factory = createCodexSessionCatalogControl({
      config,
      getRuntimeConfig: () => config,
      getPluginConfig: () => pluginConfig,
      resolveRuntimeOptions: resolveCodexSupervisionAppServerRuntimeOptions,
    });
    try {
      const source = await factory.forNode("research");
      expect(source.codexHome).not.toBe(tempDir);
      await fs.mkdir(source.codexHome, { recursive: true });
      processRuntimeMocks.runCommandBuffered.mockImplementation(async (argv, options) => {
        await fs.writeFile(path.join(options?.env?.CODEX_HOME ?? tempDir, "resumed"), "yes");
        return completeResume(argv);
      });
      const command = createCodexCliSessionNodeHostCommands((agentId) =>
        factory.forNode(agentId),
      ).find((entry) => entry.command === "codex.cli.session.resume")!;
      let entry: ReturnType<PluginRuntime["agent"]["session"]["getSessionEntry"]> = {
        sessionId: "openclaw-session",
        updatedAt: 1,
        agentHarnessId: "codex",
        modelSelectionLocked: true,
        pluginExtensions: {
          codex: {
            sessionCatalog: {
              sourceHostId: "node:node-1",
              sourceThreadId: "native-thread",
              nodeId: "node-1",
              sourceHomeId: source.sourceHomeId,
            },
          },
        },
      };
      const invoke = vi.fn<PluginRuntime["nodes"]["invoke"]>(async (request) => ({
        ok: true,
        payloadJSON: await command.handle(JSON.stringify(request.params)),
      }));
      const runtime = createPluginRuntimeMock({
        agent: { session: { getSessionEntry: () => entry } },
        nodes: { invoke },
      });
      const request = {
        runtime,
        nodeId: "node-1",
        sessionId: "native-thread",
        sessionKey: "agent:research:harness:codex:node-session:catalog-chat",
        agentId: "research",
        prompt: "continue",
        cwd: tempDir,
      };
      await expect(resumeCodexCliSessionOnNode(request)).resolves.toMatchObject({
        text: "final answer",
      });
      expect(invoke.mock.calls[0]?.[0].params).toMatchObject({
        agentId: "research",
        sourceHomeId: source.sourceHomeId,
      });
      expect(await fs.readFile(path.join(source.codexHome, "resumed"), "utf8")).toBe("yes");
      await expect(fs.stat(path.join(tempDir, "resumed"))).rejects.toMatchObject({
        code: "ENOENT",
      });

      pluginConfig = { appServer: { transport: "unix", homeScope: "user" } };
      config = { ...config };
      await expect(resumeCodexCliSessionOnNode(request)).rejects.toThrow(
        "requires a local Codex catalog source",
      );
      config = { agents: { ownership: "explicit", entries: { replacement: {} } } };
      await expect(resumeCodexCliSessionOnNode(request)).rejects.toThrow(
        "unknown Codex session catalog agent",
      );

      entry = { ...entry, pluginExtensions: undefined };
      await expect(
        resumeCodexCliSessionOnNode({ ...request, sessionKey: "agent:research:legacy-chat" }),
      ).resolves.toMatchObject({
        text: "final answer",
      });
      expect(await fs.readFile(path.join(tempDir, "resumed"), "utf8")).toBe("yes");
      expect(invoke.mock.calls.at(-1)?.[0].params).not.toHaveProperty("agentId");
      expect(invoke.mock.calls.at(-1)?.[0].params).not.toHaveProperty("sourceHomeId");
    } finally {
      await factory.stop();
    }
  });

  it("revalidates the node source after awaited CLI temporary-directory setup", async () => {
    const { createCodexSessionCatalogControl } = await import("./session-catalog-control.js");
    const { resolveCodexSupervisionAppServerRuntimeOptions } =
      await import("./app-server/config.js");
    vi.stubEnv("OPENCLAW_STATE_DIR", tempDir);
    let config: OpenClawConfig = { agents: { ownership: "explicit", entries: { research: {} } } };
    let pluginConfig = { appServer: { transport: "stdio", homeScope: "agent" } };
    const factory = createCodexSessionCatalogControl({
      config,
      getRuntimeConfig: () => config,
      getPluginConfig: () => pluginConfig,
      resolveRuntimeOptions: resolveCodexSupervisionAppServerRuntimeOptions,
    });
    const allocated = createDeferred<string>();
    const releaseAllocation = createDeferred<void>();
    const createTemporaryDirectory = fs.mkdtemp.bind(fs);
    const allocate = vi.spyOn(fs, "mkdtemp").mockImplementationOnce(async (prefix, options) => {
      const directory = await createTemporaryDirectory(prefix, options);
      allocated.resolve(directory);
      await releaseAllocation.promise;
      return directory;
    });
    const command = createCodexCliSessionNodeHostCommands((agentId) =>
      factory.forNode(agentId),
    ).find((entry) => entry.command === "codex.cli.session.resume")!;
    const request = JSON.stringify({
      sessionId: "source-race",
      agentId: "research",
      prompt: "continue",
      cwd: tempDir,
    });
    let running: Promise<string> | undefined;
    try {
      running = command.handle(request);
      const rejected = expect(running).rejects.toThrow("configuration changed");
      const directory = await allocated.promise;
      pluginConfig = { appServer: { transport: "unix", homeScope: "user" } };
      config = { ...config };
      releaseAllocation.resolve();
      await rejected;
      expect(processRuntimeMocks.runCommandBuffered).not.toHaveBeenCalled();
      await expect(fs.stat(directory)).rejects.toMatchObject({ code: "ENOENT" });
      allocate.mockRestore();
      pluginConfig = { appServer: { transport: "stdio", homeScope: "agent" } };
      config = { ...config };
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
      const runtime = createPluginRuntimeMock({
        agent: {
          session: {
            getSessionEntry: () =>
              changed === "missing row"
                ? undefined
                : {
                    sessionId: "openclaw-session",
                    updatedAt: 1,
                    agentHarnessId: "codex",
                    modelSelectionLocked: changed !== "lock",
                    pluginExtensions:
                      changed === "missing marker"
                        ? undefined
                        : {
                            codex: {
                              sessionCatalog: {
                                sourceHostId: "node:node-1",
                                sourceThreadId:
                                  changed === "thread" ? "other-thread" : "native-thread",
                                nodeId: changed === "node" ? "other-node" : "node-1",
                                sourceHomeId: codexCatalogHomeId(tempDir),
                                ...(changed === "initializing" ? { initializing: true } : {}),
                              },
                            },
                          },
                  },
          },
        },
        nodes: { invoke },
      });
      await expect(
        resumeCodexCliSessionOnNode({
          runtime,
          nodeId: "node-1",
          sessionId: "native-thread",
          sessionKey: "agent:research:harness:codex:node-session:catalog-chat",
          agentId: "research",
          prompt: "continue",
        }),
      ).rejects.toThrow("changed before its node turn");
      expect(invoke).not.toHaveBeenCalled();
    },
  );

  it("ignores Date-invalid Codex history timestamps", async () => {
    const sessionId = "019e2007-1f7e-7eb1-a42b-8c01f4b9b5cf";
    await fs.writeFile(
      path.join(tempDir, "history.jsonl"),
      JSON.stringify({ session_id: sessionId, ts: 8_700_000_000_000, text: "bad timestamp" }),
    );

    const command = createCodexCliSessionNodeHostCommands(resolveCatalogSource).find(
      (entry) => entry.command === CODEX_CLI_SESSIONS_LIST_COMMAND,
    );
    const raw = await command?.handle(JSON.stringify({ filter: "bad timestamp", limit: 5 }));
    const parsed = JSON.parse(raw ?? "{}") as {
      sessions?: Array<{
        sessionId?: string;
        updatedAt?: string;
        lastMessage?: string;
        messageCount?: number;
      }>;
    };

    expect(parsed.sessions).toEqual([
      {
        sessionId,
        lastMessage: "bad timestamp",
        messageCount: 1,
      },
    ]);
  });

  it("lists sessions from Codex session files when history is absent", async () => {
    const sessionId = "019e23d1-f33d-78e3-959e-0f56f30a5249";
    const sessionDir = path.join(tempDir, "sessions", "2026", "05", "14");
    const sessionFile = path.join(sessionDir, `rollout-2026-05-14T00-10-22-${sessionId}.jsonl`);
    await fs.mkdir(sessionDir, { recursive: true });
    await fs.writeFile(
      sessionFile,
      [
        JSON.stringify({
          timestamp: "2026-05-14T00:10:23.618Z",
          type: "session_meta",
          payload: { id: sessionId, cwd: "/tmp/codex-work" },
        }),
        JSON.stringify({
          timestamp: "2026-05-14T00:10:23.619Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "Reply with exactly: CRABBOX" }],
          },
        }),
      ].join("\n"),
    );

    const command = createCodexCliSessionNodeHostCommands(resolveCatalogSource).find(
      (entry) => entry.command === CODEX_CLI_SESSIONS_LIST_COMMAND,
    );
    const raw = await command?.handle(JSON.stringify({ filter: "crabbox", limit: 5 }));
    const parsed = JSON.parse(raw ?? "{}") as {
      sessions?: Array<{
        sessionId?: string;
        cwd?: string;
        lastMessage?: string;
        messageCount?: number;
      }>;
    };

    expect(parsed.sessions).toEqual([
      {
        sessionId,
        updatedAt: "2026-05-14T00:10:23.619Z",
        lastMessage: "Reply with exactly: CRABBOX",
        cwd: "/tmp/codex-work",
        sessionFile,
        messageCount: 1,
      },
    ]);
  });

  it("streams rollout JSONL with a record spanning many chunks", async () => {
    const sessionId = "019e23d1-f33d-78e3-959e-0f56f30a5250";
    const sessionDir = path.join(tempDir, "sessions", "2026", "05", "14");
    const sessionFile = path.join(sessionDir, `rollout-2026-05-14T00-10-22-${sessionId}.jsonl`);
    await fs.mkdir(sessionDir, { recursive: true });
    const filler = JSON.stringify({
      timestamp: "2026-05-14T00:10:23.619Z",
      type: "event_msg",
      payload: { type: "token_count", padding: "x".repeat(5 * 1_024 * 1_024) },
    });
    await fs.writeFile(
      sessionFile,
      [
        JSON.stringify({
          timestamp: "2026-05-14T00:10:23.618Z",
          type: "session_meta",
          payload: { id: sessionId, cwd: "/tmp/codex-streaming" },
        }),
        filler,
        JSON.stringify({
          timestamp: "2026-05-14T00:10:24.000Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "rollout fallback" }],
          },
        }),
      ].join("\n"),
    );
    const readFile = vi.spyOn(fs, "readFile");

    const command = createCodexCliSessionNodeHostCommands(resolveCatalogSource).find(
      (entry) => entry.command === CODEX_CLI_SESSIONS_LIST_COMMAND,
    );
    const raw = await command?.handle(JSON.stringify({ limit: 5 }));
    const parsed = JSON.parse(raw ?? "{}") as {
      sessions?: Array<{
        sessionId?: string;
        cwd?: string;
        lastMessage?: string;
        messageCount?: number;
      }>;
    };

    expect(readFile).not.toHaveBeenCalledWith(sessionFile, "utf8");
    expect(parsed.sessions).toEqual([
      {
        sessionId,
        updatedAt: "2026-05-14T00:10:24.000Z",
        cwd: "/tmp/codex-streaming",
        lastMessage: "rollout fallback",
        sessionFile,
        messageCount: 1,
      },
    ]);
  });

  it("discards partial large-file summaries and closes after a later read fails", async () => {
    const sessionId = "019e23d1-f33d-78e3-959e-0f56f30a5251";
    const sessionDir = path.join(tempDir, "sessions", "2026", "05", "14");
    const sessionFile = path.join(sessionDir, `rollout-2026-05-14T00-10-22-${sessionId}.jsonl`);
    await fs.mkdir(sessionDir, { recursive: true });
    await fs.writeFile(sessionFile, "");
    await fs.truncate(sessionFile, 5 * 1_024 * 1_024);
    const firstChunk = Buffer.from(
      `${JSON.stringify({
        timestamp: "2026-05-14T00:10:23.618Z",
        type: "session_meta",
        payload: { id: sessionId, cwd: "/tmp/partial" },
      })}\n`,
    );
    const close = vi.fn(async () => undefined);
    const read = vi
      .fn()
      .mockImplementationOnce(async (buffer: Buffer) => {
        firstChunk.copy(buffer);
        return { bytesRead: firstChunk.length, buffer };
      })
      .mockRejectedValueOnce(Object.assign(new Error("read failed"), { code: "EIO" }));
    vi.spyOn(fs, "open").mockResolvedValue({ read, close } as never);

    const command = createCodexCliSessionNodeHostCommands(resolveCatalogSource).find(
      (entry) => entry.command === CODEX_CLI_SESSIONS_LIST_COMMAND,
    );
    const raw = await command?.handle(JSON.stringify({ limit: 5 }));
    const parsed = JSON.parse(raw ?? "{}") as { sessions?: unknown[] };

    expect(parsed.sessions).toEqual([]);
    expect(read).toHaveBeenCalledTimes(2);
    expect(close).toHaveBeenCalledOnce();
  });

  it("keeps a completed large-file summary when close rejects", async () => {
    const sessionId = "019e23d1-f33d-78e3-959e-0f56f30a5252";
    const sessionDir = path.join(tempDir, "sessions", "2026", "05", "14");
    const sessionFile = path.join(sessionDir, `rollout-2026-05-14T00-10-22-${sessionId}.jsonl`);
    await fs.mkdir(sessionDir, { recursive: true });
    await fs.writeFile(sessionFile, "");
    await fs.truncate(sessionFile, 5 * 1_024 * 1_024);
    const content = Buffer.from(
      [
        JSON.stringify({
          timestamp: "2026-05-14T00:10:23.618Z",
          type: "session_meta",
          payload: { id: sessionId, cwd: "/tmp/close-failure" },
        }),
        JSON.stringify({
          timestamp: "2026-05-14T00:10:24.000Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "survives close failure" }],
          },
        }),
      ].join("\n"),
    );
    const close = vi.fn(async () => {
      throw Object.assign(new Error("close failed"), { code: "EIO" });
    });
    const read = vi
      .fn()
      .mockImplementationOnce(async (buffer: Buffer) => {
        content.copy(buffer);
        return { bytesRead: content.length, buffer };
      })
      .mockResolvedValueOnce({ bytesRead: 0, buffer: Buffer.alloc(0) });
    vi.spyOn(fs, "open").mockResolvedValue({ read, close } as never);

    const command = createCodexCliSessionNodeHostCommands(resolveCatalogSource).find(
      (entry) => entry.command === CODEX_CLI_SESSIONS_LIST_COMMAND,
    );
    const raw = await command?.handle(JSON.stringify({ limit: 5 }));
    const parsed = JSON.parse(raw ?? "{}") as {
      sessions?: Array<{
        sessionId?: string;
        updatedAt?: string;
        cwd?: string;
        lastMessage?: string;
        sessionFile?: string;
        messageCount?: number;
      }>;
    };

    expect(parsed.sessions).toEqual([
      {
        sessionId,
        updatedAt: "2026-05-14T00:10:24.000Z",
        cwd: "/tmp/close-failure",
        lastMessage: "survives close failure",
        sessionFile,
        messageCount: 1,
      },
    ]);
    expect(close).toHaveBeenCalledOnce();
  });

  it("reports malformed node session payloadJSON with an owned error", async () => {
    const invoke = vi.fn(async () => ({
      ok: true,
      payloadJSON: "{not json",
    }));
    const runtime = {
      nodes: {
        list: vi.fn(async () => ({
          nodes: [
            {
              nodeId: "node-1",
              connected: true,
              commands: [CODEX_CLI_SESSIONS_LIST_COMMAND],
            },
          ],
        })),
        invoke,
      },
    } as unknown as PluginRuntime;

    await expect(
      listCodexCliSessionsOnNode({
        runtime,
        requestedNode: "node-1",
      }),
    ).rejects.toThrow("Codex CLI node command returned malformed payloadJSON.");
    expect(invoke).toHaveBeenCalledWith(expect.objectContaining({ scopes: ["operator.write"] }));
  });

  it("keeps Codex history session previews on UTF-16 code point boundaries", async () => {
    const sessionId = "019e2007-1f7e-7eb1-a42b-8c01f4b9b5ce";
    const text = `${"a".repeat(136)}🤖tail`;
    await fs.writeFile(
      path.join(tempDir, "history.jsonl"),
      JSON.stringify({ session_id: sessionId, ts: 1778678322, text }),
    );

    const command = createCodexCliSessionNodeHostCommands(resolveCatalogSource).find(
      (entry) => entry.command === CODEX_CLI_SESSIONS_LIST_COMMAND,
    );
    const raw = await command?.handle(JSON.stringify({ filter: "", limit: 5 }));
    const parsed = JSON.parse(raw ?? "{}") as {
      sessions?: Array<{ lastMessage?: string }>;
    };

    expect(parsed.sessions?.[0]?.lastMessage).toBe(`${"a".repeat(136)}...`);
    expect(parsed.sessions?.[0]?.lastMessage).not.toContain("\ud83e");
    expect(parsed.sessions?.[0]?.lastMessage).not.toContain("\udd16");
  });

  it("keeps Codex session-file previews on UTF-16 code point boundaries", async () => {
    const sessionId = "019e23d1-f33d-78e3-959e-0f56f30a5248";
    const sessionDir = path.join(tempDir, "sessions", "2026", "05", "14");
    const sessionFile = path.join(sessionDir, `rollout-2026-05-14T00-10-22-${sessionId}.jsonl`);
    const text = `${"b".repeat(136)}🤖tail`;

    await fs.mkdir(sessionDir, { recursive: true });
    await fs.writeFile(
      sessionFile,
      [
        JSON.stringify({
          timestamp: "2026-05-14T00:10:23.618Z",
          type: "session_meta",
          payload: { id: sessionId, cwd: "/tmp/codex-work" },
        }),
        JSON.stringify({
          timestamp: "2026-05-14T00:10:23.619Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text }],
          },
        }),
      ].join("\n"),
    );

    const command = createCodexCliSessionNodeHostCommands(resolveCatalogSource).find(
      (entry) => entry.command === CODEX_CLI_SESSIONS_LIST_COMMAND,
    );
    const raw = await command?.handle(JSON.stringify({ filter: "", limit: 5 }));
    const parsed = JSON.parse(raw ?? "{}") as {
      sessions?: Array<{ lastMessage?: string }>;
    };

    expect(parsed.sessions?.[0]?.lastMessage).toBe(`${"b".repeat(136)}...`);
    expect(parsed.sessions?.[0]?.lastMessage).not.toContain("\ud83e");
    expect(parsed.sessions?.[0]?.lastMessage).not.toContain("\udd16");
  });
});
