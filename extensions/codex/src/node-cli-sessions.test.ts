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
import { readJsonlHead, readJsonlTail } from "./jsonl-lines.js";
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

  it("reads a large rollout through bounded head and tail windows", async () => {
    const sessionId = "019e23d1-f33d-78e3-959e-0f56f30a5250";
    const sessionFile = await writeRollout(sessionId, [
      sessionMeta(sessionId, "/tmp/codex-streaming"),
      userMessage("2026-05-14T00:10:23.700Z", "first ask"),
      filler(2 * 1_024 * 1_024),
      userMessage("2026-05-14T00:10:23.800Z", "buried ask"),
      filler(2 * 1_024 * 1_024),
      userMessage("2026-05-14T00:10:24.000Z", "rollout fallback"),
    ]);
    const fileSize = (await fs.stat(sessionFile)).size;
    const readFile = vi.spyOn(fs, "readFile");
    const reads = spyOnRolloutReads();

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
    // Head (512 KiB) plus tail (256 KiB) — never the whole 4 MiB rollout.
    expect(reads.bytes()).toBeLessThanOrEqual(768 * 1_024);
    expect(fileSize).toBeGreaterThan(4 * 1_024 * 1_024);
    expect(parsed.sessions).toEqual([
      {
        sessionId,
        updatedAt: "2026-05-14T00:10:24.000Z",
        cwd: "/tmp/codex-streaming",
        // Exact: the last user message lives in the tail window.
        lastMessage: "rollout fallback",
        sessionFile,
        // Windowed: "buried ask" sits between the two windows, so the count is marked partial.
        messageCount: 2,
        partialScan: true,
      },
    ]);
  });

  it("counts each record once when an oversized session_meta escalates past the file size", async () => {
    const sessionId = "019e23d1-f33d-78e3-959e-0f56f30a5260";
    const sessionFile = await writeRollout(sessionId, [
      sessionMeta(sessionId, "/tmp/codex-escalated", 900 * 1_024),
      userMessage("2026-05-14T00:10:24.100Z", "one"),
      userMessage("2026-05-14T00:10:24.200Z", "two"),
      userMessage("2026-05-14T00:10:24.300Z", "three"),
    ]);
    const size = (await fs.stat(sessionFile)).size;
    // Larger than the head window, so the first read finds no complete record and escalates; small
    // enough that the escalated read reaches EOF, which is where a fixed tail would re-read.
    expect(size).toBeGreaterThan(768 * 1_024);
    expect(size).toBeLessThan(4 * 1_024 * 1_024);

    const parsed = await runSessionsList({ limit: 5 });

    expect(parsed.sessions).toEqual([
      {
        sessionId,
        updatedAt: "2026-05-14T00:10:24.300Z",
        lastMessage: "three",
        cwd: "/tmp/codex-escalated",
        sessionFile,
        messageCount: 3,
      },
    ]);
  });

  it("counts each record once when the escalated head window meets the tail window", async () => {
    const sessionId = "019e23d1-f33d-78e3-959e-0f56f30a5261";
    const meta = sessionMeta(sessionId, "/tmp/codex-overlap", 900 * 1_024);
    const records = [meta];
    let bytes = meta.length + 1;
    const padTo = (target: number) => {
      while (bytes < target) {
        const record = filler(Math.min(256 * 1_024, target - bytes));
        records.push(record);
        bytes += record.length + 1;
      }
    };
    padTo(3_950 * 1_024);
    records.push(userMessage("2026-05-14T00:10:25.100Z", "overlap ask"));
    bytes += records.at(-1)?.length ?? 0;
    padTo(4_150 * 1_024);
    records.push(userMessage("2026-05-14T00:10:25.200Z", "final ask"));
    const sessionFile = await writeRollout(sessionId, records);
    // Pin the property the fixture exists to exercise rather than the sizes that produce it: an
    // unanchored tail reaches back before the head stopped, and "overlap ask" is inside that span.
    const head = await readJsonlHead(sessionFile, 4 * 1_024 * 1_024);
    const unanchored = await readJsonlTail(sessionFile, 256 * 1_024);
    expect(head?.complete).toBe(false);
    expect(unanchored?.start).toBeLessThan(head?.endOffset ?? 0);
    expect(unanchored?.lines.join("\n")).toContain("overlap ask");
    expect(head?.lines.join("\n")).toContain("overlap ask");

    const parsed = await runSessionsList({ limit: 5 });

    expect(parsed.sessions).toEqual([
      {
        sessionId,
        updatedAt: "2026-05-14T00:10:25.200Z",
        lastMessage: "final ask",
        cwd: "/tmp/codex-overlap",
        sessionFile,
        // Two user records, each scanned once: the windows meet, so the count stays exact.
        messageCount: 2,
      },
    ]);
  });

  it("falls back to mtime when the tail window holds no complete record", async () => {
    const sessionId = "019e23d1-f33d-78e3-959e-0f56f30a5262";
    const mtime = new Date("2026-05-20T11:22:33.000Z");
    const sessionFile = await writeRollout(sessionId, [
      sessionMeta(sessionId, "/tmp/codex-huge-tail"),
      userMessage("2026-05-14T00:10:23.700Z", "early ask"),
      filler(700 * 1_024),
      // One record wider than the tail window, so the window opens mid-record and ends at EOF.
      filler(400 * 1_024),
    ]);
    await fs.utimes(sessionFile, mtime, mtime);

    const parsed = await runSessionsList({ limit: 5 });

    expect(parsed.sessions).toEqual([
      {
        sessionId,
        // Not the head's "2026-05-14T00:10:23.700Z": records after it went unread.
        updatedAt: mtime.toISOString(),
        lastMessage: "early ask",
        cwd: "/tmp/codex-huge-tail",
        sessionFile,
        messageCount: 1,
        partialScan: true,
      },
    ]);
  });

  it("keeps exact counts for rollouts small enough to read whole", async () => {
    const sessionId = "019e23d1-f33d-78e3-959e-0f56f30a5253";
    const sessionDir = path.join(tempDir, "sessions", "2026", "05", "14");
    const sessionFile = path.join(sessionDir, `rollout-2026-05-14T00-10-22-${sessionId}.jsonl`);
    await fs.mkdir(sessionDir, { recursive: true });
    await fs.writeFile(
      sessionFile,
      [
        JSON.stringify({
          timestamp: "2026-05-14T00:10:23.618Z",
          type: "session_meta",
          payload: { id: sessionId, cwd: "/tmp/codex-small" },
        }),
        ...["one", "two", "three"].map((text, index) =>
          JSON.stringify({
            timestamp: `2026-05-14T00:10:2${String(index + 4)}.000Z`,
            type: "response_item",
            payload: { type: "message", role: "user", content: [{ type: "input_text", text }] },
          }),
        ),
      ].join("\n"),
    );

    const command = createCodexCliSessionNodeHostCommands(resolveCatalogSource).find(
      (entry) => entry.command === CODEX_CLI_SESSIONS_LIST_COMMAND,
    );
    const raw = await command?.handle(JSON.stringify({ limit: 5 }));

    expect(JSON.parse(raw ?? "{}")).toMatchObject({
      sessions: [
        {
          sessionId,
          lastMessage: "three",
          messageCount: 3,
        },
      ],
    });
    expect(JSON.parse(raw ?? "{}").sessions[0]).not.toHaveProperty("partialScan");
  });

  it("scans only the most recent rollouts past the requested limit", async () => {
    const opened = await writeRolloutFixtures(40);

    const command = createCodexCliSessionNodeHostCommands(resolveCatalogSource).find(
      (entry) => entry.command === CODEX_CLI_SESSIONS_LIST_COMMAND,
    );
    const reads = spyOnRolloutReads();
    const raw = await command?.handle(JSON.stringify({ limit: 2 }));
    const parsed = JSON.parse(raw ?? "{}") as { sessions?: Array<{ sessionId?: string }> };

    // limit (2) + SESSION_FILE_SCAN_HEADROOM (20), newest first — not all 40 rollouts.
    expect(reads.files().size).toBe(22);
    expect(parsed.sessions?.map((entry) => entry.sessionId)).toEqual([
      opened[0]?.sessionId,
      opened[1]?.sessionId,
    ]);
  });

  it("finds a session by id even when it is older than the scan window", async () => {
    const rollouts = await writeRolloutFixtures(210);
    const oldest = rollouts.at(-1);

    const command = createCodexCliSessionNodeHostCommands(resolveCatalogSource).find(
      (entry) => entry.command === CODEX_CLI_SESSIONS_LIST_COMMAND,
    );
    const raw = await command?.handle(JSON.stringify({ limit: 50, filter: oldest?.sessionId }));
    const parsed = JSON.parse(raw ?? "{}") as { sessions?: Array<{ sessionId?: string }> };

    expect(parsed.sessions?.map((entry) => entry.sessionId)).toEqual([oldest?.sessionId]);
  });

  it("finds a session by cwd past the rollout count a filtered scan used to stop at", async () => {
    const rollouts = await writeRolloutFixtures(210, {
      cwdFor: (index) => (index === 209 ? "/tmp/codex-archive" : "/tmp/codex-many"),
    });
    const oldest = rollouts.at(-1);

    const parsed = await runSessionsList({ limit: 50, filter: "/tmp/codex-archive" });

    // Nothing in its filename matches, so this session is only reachable by reading past the 200th
    // rollout. A scan that stops earlier has to report itself truncated instead of answering "none".
    expect(parsed.sessions?.map((entry) => entry.sessionId)).toEqual([oldest?.sessionId]);
    expect(parsed).toMatchObject({ scannedFileCount: 210, sessionFileCount: 210 });
    expect(parsed).not.toHaveProperty("searchTruncated");
  });

  it("reaches a cwd match past the filtered candidate ceiling only when the complete search is asked for", async () => {
    // FILTERED_SESSION_FILE_SCAN_CAP is 2,000, so the 2,001st rollout is the first one the
    // bounded scan can never open — nothing in its filename matches a directory filter, and a
    // rerun revisits the same 2,000 candidates.
    const rollouts = await writeRolloutFixtures(2_001, {
      cwdFor: (index) => (index === 2_000 ? "/tmp/codex-archive" : "/tmp/codex-many"),
    });
    const oldest = rollouts.at(-1);

    const bounded = await runSessionsList({ limit: 50, filter: "/tmp/codex-archive" });
    const complete = await runSessionsList({
      limit: 50,
      filter: "/tmp/codex-archive",
      searchAll: true,
    });

    // The bounded answer is empty, and says so as a cut search rather than as "no such session".
    expect(bounded.sessions).toEqual([]);
    expect(bounded).toMatchObject({
      scannedFileCount: 2_000,
      sessionFileCount: 2_001,
      searchTruncated: true,
    });
    // The complete search opens every rollout and returns the match the ceiling was hiding, so
    // the bound costs reachability only for the request that asked for it.
    expect(complete.sessions?.map((entry) => entry.sessionId)).toEqual([oldest?.sessionId]);
    expect(complete).toMatchObject({ scannedFileCount: 2_001, sessionFileCount: 2_001 });
    expect(complete).not.toHaveProperty("searchTruncated");
  }, 60_000);

  it("keeps scanning past a full page when the complete search is asked for", async () => {
    await writeRolloutFixtures(60);

    const parsed = await runSessionsList({
      limit: 5,
      filter: "/tmp/codex-many",
      searchAll: true,
    });

    // The match early-out is the other reason a bounded scan stops short. A complete search has to
    // clear it too, or the 35 rollouts behind a full page stay unread and the answer stays cut.
    expect(parsed.sessions).toHaveLength(5);
    expect(parsed).toMatchObject({ scannedFileCount: 60, sessionFileCount: 60 });
    expect(parsed).not.toHaveProperty("searchTruncated");
  });

  it("stops a filtered scan once the page is full and reports the search as truncated", async () => {
    await writeRolloutFixtures(60);

    const parsed = await runSessionsList({ limit: 5, filter: "/tmp/codex-many" });

    // limit (5) + SESSION_FILE_SCAN_HEADROOM (20) matches is enough to fill a newest-first page,
    // so the remaining 35 rollouts stay unread — and the result says the search was cut.
    expect(parsed.sessions).toHaveLength(5);
    expect(parsed).toMatchObject({
      scannedFileCount: 25,
      sessionFileCount: 60,
      searchTruncated: true,
    });
  });

  it("stops a filtered scan at the byte budget and reports the search as truncated", async () => {
    // A 768 KiB rollout is read head-and-tail in one window, so each one spends 768 KiB of the
    // 256 MiB budget. The budget is checked between files against bytes already spent, so the scan
    // reads one file past the point where it runs out: 342 rather than 341.
    await writeRolloutFixtures(345, {
      cwdFor: () => "/tmp/codex-budget",
      padToBytes: 768 * 1024,
    });

    const parsed = await runSessionsList({ limit: 50, filter: "/tmp/codex-unmatched" });

    expect(parsed.sessions).toEqual([]);
    expect(parsed).toMatchObject({
      scannedFileCount: 342,
      sessionFileCount: 345,
      searchTruncated: true,
    });
  });

  it("charges the oversized-session_meta escalation against the filtered scan budget", async () => {
    // Every rollout here forces the escalation: `session_meta` is wider than the 512 KiB initial
    // head window, so each file costs 512 KiB + a 1 MiB re-read, not the 768 KiB an estimate based
    // on `min(size, head + tail)` would have charged. Under that estimate 175 rollouts fit inside
    // the 256 MiB budget and the scan reported itself complete while reading ~262 MB; the budget
    // has to be charged what was actually read.
    await writeRolloutFixtures(175, {
      cwdFor: () => "/tmp/codex-escalated",
      metaPadBytes: 600_000,
      padToBytes: 1024 * 1024,
    });

    const reads = spyOnRolloutReads();
    const parsed = await runSessionsList({ limit: 50, filter: "/tmp/codex-unmatched" });

    expect(parsed.sessions).toEqual([]);
    expect(parsed).toMatchObject({ sessionFileCount: 175, searchTruncated: true });
    // 512 KiB + a 1 MiB re-read each, so 256 MiB runs out after 171 of the 175 rollouts.
    // Charging `min(size, head + tail)` instead would have called all 175 a complete search.
    expect(parsed.scannedFileCount).toBe(171);
    // The stated bound: the 256 MiB budget plus at most one file's maximum summary read — the
    // 512 KiB initial head window, the 4 MiB escalation re-read, and the 256 KiB tail window, as
    // documented on FILTERED_SESSION_SCAN_BUDGET_BYTES.
    const maxSummaryReadBytes = 512 * 1024 + 4 * 1024 * 1024 + 256 * 1024;
    expect(reads.bytes()).toBeLessThanOrEqual(256 * 1024 * 1024 + maxSummaryReadBytes);
  });

  it("keeps an unfiltered listing free of the truncation marker", async () => {
    await writeRolloutFixtures(40);

    const parsed = await runSessionsList({ limit: 2 });

    expect(parsed).toMatchObject({ scannedFileCount: 22, sessionFileCount: 40 });
    expect(parsed).not.toHaveProperty("searchTruncated");
  });

  it("reads cwd from an oversized session_meta on a history-backed session outside the scan window", async () => {
    const sessionId = "019e23d1-f33d-78e3-959e-0f56f30a52aa";
    await writeRolloutFixtures(25);
    const sessionDir = path.join(tempDir, "sessions", "2026", "05", "14");
    const sessionFile = path.join(sessionDir, `rollout-2026-05-13T00-00-00-${sessionId}.jsonl`);
    // A `session_meta` past the 512 KiB head window. Only the escalation to 4 MiB reaches it.
    await fs.writeFile(
      sessionFile,
      `${JSON.stringify({
        timestamp: "2026-05-13T00:00:01.000Z",
        type: "session_meta",
        payload: { id: sessionId, cwd: "/tmp/codex-oversized", instructions: "x".repeat(600_000) },
      })}\n`,
    );
    const stale = new Date(Date.UTC(2026, 4, 13));
    await fs.utimes(sessionFile, stale, stale);
    // History makes this the newest session even though its rollout is the oldest file on disk, so
    // it lands in the listing while sitting outside the rollouts the summary scan reads.
    await fs.writeFile(
      path.join(tempDir, "history.jsonl"),
      `${JSON.stringify({ session_id: sessionId, ts: 1800000000, text: "oversized meta ask" })}\n`,
    );

    const parsed = await runSessionsList({ limit: 1 });

    expect(parsed.sessions).toMatchObject([{ sessionId, cwd: "/tmp/codex-oversized" }]);
  });

  it("reports a search as cut when a filtered-out summary had an unread span", async () => {
    const sessionId = "019e23d1-f33d-78e3-959e-0f56f30a5270";
    const sessionDir = path.join(tempDir, "sessions", "2026", "05", "14");
    await fs.mkdir(sessionDir, { recursive: true });
    const sessionFile = path.join(sessionDir, `rollout-2026-05-14T00-10-22-${sessionId}.jsonl`);
    // One rollout, no history.jsonl, and the only record carrying the filter term sits between the
    // head and tail windows: 600 KB of filler pushes it past the 512 KiB head, and a final 400 KB
    // agent record with no trailing newline fills the 256 KiB tail so the tail yields no record.
    await fs.writeFile(
      sessionFile,
      [
        JSON.stringify({
          timestamp: "2026-05-14T00:10:20.000Z",
          type: "session_meta",
          payload: { id: sessionId, cwd: "/tmp/window-gap" },
        }),
        userMessage("2026-05-14T00:10:21.000Z", "early ask"),
        filler(600_000),
        userMessage("2026-05-14T00:10:25.000Z", "please check needle-term now"),
        JSON.stringify({
          timestamp: "2026-05-14T00:10:26.000Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "y".repeat(400_000) }],
          },
        }),
      ].join("\n"),
    );

    const parsed = await runSessionsList({ limit: 50, filter: "needle-term" });

    // Every file was opened, so a file-count comparison alone calls this a complete search. It is
    // not: the one record that matches was never read, and answering "none" without qualification
    // asserts the session does not exist.
    expect(parsed.sessions).toEqual([]);
    expect(parsed).toMatchObject({
      scannedFileCount: 1,
      sessionFileCount: 1,
      searchTruncated: true,
      unreadSpanCount: 1,
    });

    // Same fixture, same filter, complete search: the record between the two windows is now read,
    // so the session the bounded scan could only warn about is actually returned. Dropping the
    // candidate ceiling alone would not have done this — the file was already opened.
    const complete = await runSessionsList({
      limit: 50,
      filter: "needle-term",
      searchAll: true,
    });

    expect(complete.sessions?.map((entry) => entry.sessionId)).toEqual([sessionId]);
    expect(complete.sessions?.[0]).toMatchObject({ cwd: "/tmp/window-gap", messageCount: 2 });
    expect(complete.sessions?.[0]).not.toHaveProperty("partialScan");
    expect(complete).toMatchObject({ scannedFileCount: 1, sessionFileCount: 1 });
    expect(complete).not.toHaveProperty("searchTruncated");
    expect(complete).not.toHaveProperty("unreadSpanCount");
  });

  it("reports a search as cut when a history-backed row hid its rollout's unread span", async () => {
    const sessionId = "019e23d1-f33d-78e3-959e-0f56f30a5271";
    const sessionDir = path.join(tempDir, "sessions", "2026", "05", "14");
    await fs.mkdir(sessionDir, { recursive: true });
    const sessionFile = path.join(sessionDir, `rollout-2026-05-14T00-10-22-${sessionId}.jsonl`);
    // `session_meta` wider than the 4 MiB escalation, so neither the history-backed `cwd` lookup
    // nor the summary read recovers a directory for this session.
    await fs.writeFile(
      sessionFile,
      `${JSON.stringify({
        timestamp: "2026-05-14T00:10:23.000Z",
        type: "session_meta",
        payload: { id: sessionId, cwd: "/tmp/codex-hidden", instructions: "x".repeat(5_000_000) },
      })}\n`,
    );
    // The history row supplies an exact message count and no partial marker. Reading the marker
    // from whichever source supplied the count used to clear the rollout's own unread span here.
    await fs.writeFile(
      path.join(tempDir, "history.jsonl"),
      `${JSON.stringify({ session_id: sessionId, ts: 1778678322, text: "history ask" })}\n`,
    );

    const parsed = await runSessionsList({ limit: 50, filter: "/tmp/codex-hidden" });

    // The only rollout under this codex-home went partly unread and its `cwd` was never recovered,
    // so an unqualified empty answer would assert that no session sits in that directory.
    expect(parsed.sessions).toEqual([]);
    expect(parsed).toMatchObject({
      scannedFileCount: 1,
      sessionFileCount: 1,
      searchTruncated: true,
      unreadSpanCount: 1,
    });
  });

  it("recovers a cwd past the metadata escalation when the complete search is asked for", async () => {
    const sessionId = "019e23d1-f33d-78e3-959e-0f56f30a5272";
    const sessionDir = path.join(tempDir, "sessions", "2026", "05", "14");
    await fs.mkdir(sessionDir, { recursive: true });
    const sessionFile = path.join(sessionDir, `rollout-2026-05-14T00-10-22-${sessionId}.jsonl`);
    // `session_meta` wider than the 4 MiB escalation. No window reaches its `cwd`, and neither does
    // the history-backed first-line lookup, so only a whole-file read recovers the directory.
    await fs.writeFile(
      sessionFile,
      [
        JSON.stringify({
          timestamp: "2026-05-14T00:10:23.000Z",
          type: "session_meta",
          payload: { id: sessionId, cwd: "/tmp/codex-deep", instructions: "x".repeat(5_000_000) },
        }),
        userMessage("2026-05-14T00:10:24.000Z", "deep ask"),
      ].join("\n"),
    );

    const bounded = await runSessionsList({ limit: 50, filter: "/tmp/codex-deep" });
    const complete = await runSessionsList({
      limit: 50,
      filter: "/tmp/codex-deep",
      searchAll: true,
    });

    // Oversized directory metadata is the other half of the same reachability gap: the file is
    // opened either way, and only the reader decides whether the `cwd` is ever seen.
    expect(bounded.sessions).toEqual([]);
    expect(bounded).toMatchObject({ searchTruncated: true, unreadSpanCount: 1 });
    expect(complete.sessions?.map((entry) => entry.sessionId)).toEqual([sessionId]);
    expect(complete.sessions?.[0]).toMatchObject({ cwd: "/tmp/codex-deep", messageCount: 1 });
    expect(complete).not.toHaveProperty("searchTruncated");
  });

  it("keeps a session whose metadata and final record both outrun their windows", async () => {
    const sessionId = "019e23d1-f33d-78e3-959e-0f56f30a5260";
    const sessionDir = path.join(tempDir, "sessions", "2026", "05", "14");
    await fs.mkdir(sessionDir, { recursive: true });
    const sessionFile = path.join(sessionDir, `rollout-2026-05-14T00-10-22-${sessionId}.jsonl`);
    // One record wider than the 4 MiB head escalation, and no newline anywhere after it — so the
    // head window yields nothing and the 256 KiB tail window opens inside the same record.
    await fs.writeFile(
      sessionFile,
      `${JSON.stringify({
        timestamp: "2026-05-14T00:10:23.618Z",
        type: "session_meta",
        payload: { id: sessionId, cwd: "/tmp/huge-meta", instructions: "x".repeat(5_000_000) },
      })}\n`,
    );
    const updatedAt = new Date(Date.UTC(2026, 4, 14));
    await fs.utimes(sessionFile, updatedAt, updatedAt);

    const parsed = await runSessionsList({ limit: 5, filter: sessionId });

    // Unreadable windows are not an absent session: the id is in the filename, and dropping the
    // row here would also make `/codex resume <id> --bind` unable to resolve it.
    expect(parsed.sessions).toMatchObject([
      { sessionId, sessionFile, partialScan: true, messageCount: 0 },
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

  it("keeps a completed summary when close rejects", async () => {
    const sessionId = "019e23d1-f33d-78e3-959e-0f56f30a5252";
    const sessionDir = path.join(tempDir, "sessions", "2026", "05", "14");
    const sessionFile = path.join(sessionDir, `rollout-2026-05-14T00-10-22-${sessionId}.jsonl`);
    await fs.mkdir(sessionDir, { recursive: true });
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
    await fs.writeFile(sessionFile, content);
    const close = vi.fn(async () => {
      throw Object.assign(new Error("close failed"), { code: "EIO" });
    });
    const read = vi.fn(async (buffer: Buffer) => {
      content.copy(buffer);
      return { bytesRead: content.length, buffer };
    });
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

  it("leaves rollout counts absent when a node build does not report them", async () => {
    const invoke = vi.fn(async () => ({
      ok: true,
      payloadJSON: JSON.stringify({
        codexHome: "/Users/mariano/.codex",
        searchTruncated: true,
        sessions: [],
      }),
    }));
    const runtime = {
      nodes: {
        list: vi.fn(async () => ({
          nodes: [
            { nodeId: "node-1", connected: true, commands: [CODEX_CLI_SESSIONS_LIST_COMMAND] },
          ],
        })),
        invoke,
      },
    } as unknown as PluginRuntime;

    const listing = await listCodexCliSessionsOnNode({ runtime, requestedNode: "node-1" });

    // Coercing an absent counter to 0 would make the truncation notice claim "0 of 0 rollouts".
    expect(listing.result.scannedFileCount).toBeUndefined();
    expect(listing.result.sessionFileCount).toBeUndefined();
    expect(listing.result.searchTruncated).toBe(true);
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

  function sessionMeta(sessionId: string, cwd: string, padding = 0): string {
    return JSON.stringify({
      timestamp: "2026-05-14T00:10:23.618Z",
      type: "session_meta",
      // Real rollouts embed the whole instruction set here, which is what makes this record big.
      payload: { id: sessionId, cwd, instructions: "i".repeat(padding) },
    });
  }

  function userMessage(timestamp: string, text: string): string {
    return JSON.stringify({
      timestamp,
      type: "response_item",
      payload: { type: "message", role: "user", content: [{ type: "input_text", text }] },
    });
  }

  function filler(padding: number): string {
    return JSON.stringify({
      timestamp: "2026-05-14T00:10:23.619Z",
      type: "event_msg",
      payload: { type: "token_count", padding: "x".repeat(padding) },
    });
  }

  async function writeRollout(sessionId: string, records: string[]): Promise<string> {
    const sessionDir = path.join(tempDir, "sessions", "2026", "05", "14");
    await fs.mkdir(sessionDir, { recursive: true });
    const sessionFile = path.join(sessionDir, `rollout-2026-05-14T00-10-22-${sessionId}.jsonl`);
    await fs.writeFile(sessionFile, records.join("\n"));
    return sessionFile;
  }

  async function runSessionsList(params: Record<string, unknown>): Promise<{
    sessions?: Array<Record<string, unknown>>;
    scannedFileCount?: number;
    sessionFileCount?: number;
    searchTruncated?: boolean;
    unreadSpanCount?: number;
  }> {
    const command = createCodexCliSessionNodeHostCommands(resolveCatalogSource).find(
      (entry) => entry.command === CODEX_CLI_SESSIONS_LIST_COMMAND,
    );
    return JSON.parse((await command?.handle(JSON.stringify(params))) ?? "{}") as {
      sessions?: Array<Record<string, unknown>>;
      scannedFileCount?: number;
      sessionFileCount?: number;
      searchTruncated?: boolean;
      unreadSpanCount?: number;
    };
  }

  /** Writes `count` rollouts, newest first, with distinct mtimes so recency ordering is stable. */
  async function writeRolloutFixtures(
    count: number,
    options?: {
      cwdFor?: (index: number) => string;
      padToBytes?: number;
      /** Pads `session_meta` itself, so the record is wider than the initial head window. */
      metaPadBytes?: number;
    },
  ): Promise<Array<{ sessionId: string; file: string }>> {
    const sessionDir = path.join(tempDir, "sessions", "2026", "05", "14");
    await fs.mkdir(sessionDir, { recursive: true });
    const created: Array<{ sessionId: string; file: string }> = [];
    for (let index = 0; index < count; index += 1) {
      const sessionId = `019e23d1-f33d-78e3-959e-${index.toString(16).padStart(12, "0")}`;
      const file = path.join(sessionDir, `rollout-2026-05-14T00-10-22-${sessionId}.jsonl`);
      const updatedAt = new Date(Date.UTC(2026, 4, 14) - index * 60_000);
      await fs.writeFile(
        file,
        [
          JSON.stringify({
            timestamp: updatedAt.toISOString(),
            type: "session_meta",
            payload: {
              id: sessionId,
              cwd: options?.cwdFor?.(index) ?? "/tmp/codex-many",
              ...(options?.metaPadBytes ? { instructions: "x".repeat(options.metaPadBytes) } : {}),
            },
          }),
          JSON.stringify({
            timestamp: updatedAt.toISOString(),
            type: "response_item",
            payload: {
              type: "message",
              role: "user",
              content: [{ type: "input_text", text: `ask ${String(index)}` }],
            },
          }),
        ].join("\n"),
      );
      if (options?.padToBytes) {
        // Sparse padding: the scan charges its window against the budget without the fixture
        // costing that many bytes on disk.
        await fs.truncate(file, options.padToBytes);
      }
      await fs.utimes(file, updatedAt, updatedAt);
      created.push({ sessionId, file });
    }
    return created;
  }

  /** Records which rollouts were opened and how many bytes each listing actually read. */
  function spyOnRolloutReads(): { files: () => Set<string>; bytes: () => number } {
    const openFile = fs.open;
    const files = new Set<string>();
    let bytes = 0;
    vi.spyOn(fs, "open").mockImplementation((async (file: string, flags: string) => {
      files.add(file);
      const handle = await openFile(file, flags);
      return {
        read: async (buffer: Buffer, offset: number, length: number, position: number | null) => {
          const result = await handle.read(buffer, offset, length, position);
          bytes += result.bytesRead;
          return result;
        },
        close: () => handle.close(),
      };
    }) as never);
    return { files: () => files, bytes: () => bytes };
  }
});
