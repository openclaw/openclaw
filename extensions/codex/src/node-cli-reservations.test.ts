import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import { createTestPluginServiceScheduler } from "openclaw/plugin-sdk/plugin-test-api";
import {
  createPluginRecord,
  createPluginRegistry,
  createPluginRuntimeMock,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import plugin from "../index.js";
import manifest from "../openclaw.plugin.json" with { type: "json" };
import { resumeCodexCliSessionOnNode } from "./node-cli-sessions.js";
import { codexCatalogHomeId } from "./session-catalog-home-id.js";
import { readNodeSessionMarker } from "./session-catalog-node-adoption.js";

type RunCommandBuffered =
  (typeof import("openclaw/plugin-sdk/process-runtime"))["runCommandBuffered"];
const processRuntimeMocks = vi.hoisted(() => ({
  runCommandBuffered: vi.fn<RunCommandBuffered>(),
}));

vi.mock("openclaw/plugin-sdk/process-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/process-runtime")>()),
  runCommandBuffered: processRuntimeMocks.runCommandBuffered,
}));

const runCommand = processRuntimeMocks.runCommandBuffered;
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const sessionId = "01a0c710-4cad-7049-858e-b5a9fb33c013";
const symlink = (target: string, alias: string) =>
  fs.symlink(target, alias, process.platform === "win32" ? "junction" : "dir");

const completeResume: RunCommandBuffered = async (argv, options) => {
  const outputPath = argv[argv.indexOf("--output-last-message") + 1];
  const codexHome = options?.env?.CODEX_HOME;
  if (!outputPath || !codexHome) {
    throw new Error("missing Codex output path or home");
  }
  await fs.writeFile(outputPath, await fs.realpath(codexHome));
  return {
    stdout: Buffer.alloc(0),
    stderr: Buffer.alloc(0),
    code: 0,
    signal: null,
    killed: false,
    termination: "exit",
  };
};

async function createRegisteredResume() {
  const stateDir = tempDirs.make("codex-node-reservations-");
  const alphaDir = path.join(stateDir, "alpha");
  const betaDir = path.join(stateDir, "beta");
  const alphaHome = path.join(alphaDir, "codex-home");
  const betaHome = path.join(betaDir, "codex-home");
  const aliasHome = path.join(stateDir, "native-home");
  const aliasAgentDir = path.join(stateDir, "alpha-alias");
  await fs.mkdir(alphaHome, { recursive: true });
  await fs.mkdir(betaHome, { recursive: true });
  await symlink(alphaHome, aliasHome);
  await symlink(alphaDir, aliasAgentDir);
  for (const home of [alphaHome, betaHome]) {
    await fs.mkdir(path.join(home, "sessions"));
    await fs.writeFile(
      path.join(home, "sessions", `rollout-${sessionId}.jsonl`),
      `${JSON.stringify({ type: "session_meta", payload: { id: sessionId, cwd: stateDir } })}\n`,
    );
  }
  vi.stubEnv("CODEX_HOME", aliasHome);
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(stateDir, "openclaw.json"));
  const pluginConfig = {
    appServer: { transport: "stdio", homeScope: "agent" },
    sessionCatalog: { enabled: false },
  };
  const agents = (agentDir: string) => ({
    ownership: "explicit" as const,
    entries: { alpha: { agentDir }, beta: { agentDir: betaDir } },
  });
  let config: OpenClawConfig = {
    agents: agents(alphaDir),
    plugins: { entries: { codex: { enabled: true, config: pluginConfig } } },
  };
  let sessionEntry: ReturnType<PluginRuntime["agent"]["session"]["getSessionEntry"]>;
  const invoke = vi.fn<PluginRuntime["nodes"]["invoke"]>();
  const runtime = createPluginRuntimeMock({
    config: { current: () => config },
    agent: { session: { getSessionEntryAsync: async () => sessionEntry } },
    nodes: { invoke },
  });
  const logger = { info() {}, warn() {}, error() {}, debug() {} };
  const registry = createPluginRegistry({
    runtime,
    logger,
    activateGlobalSideEffects: false,
  });
  const record = createPluginRecord({
    id: manifest.id,
    source: path.join(stateDir, "index.js"),
    nativeSessionCatalog: manifest.setup.nativeSessionCatalog,
  });
  registry.registry.plugins.push(record);
  plugin.register(registry.createApi(record, { config, pluginConfig }));
  const command = registry.registry.nodeHostCommands.find(
    (entry) => entry.command.command === "codex.cli.session.resume",
  )?.command;
  if (!command) {
    throw new Error("Codex resume command did not register");
  }
  invoke.mockImplementation(async (request) => ({
    ok: true,
    payloadJSON: await command.handle(JSON.stringify(request.params)),
  }));
  const scheduler = createTestPluginServiceScheduler();
  return {
    alphaHome: await fs.realpath(alphaHome),
    betaHome: await fs.realpath(betaHome),
    aliasAgentDir,
    command,
    invoke,
    runtime,
    resume: (sessionKey: string) => ({
      runtime,
      nodeId: "node-1",
      sessionId,
      sessionKey,
      agentId: "alpha",
      prompt: "continue",
    }),
    setSessionEntry: (entry: typeof sessionEntry) => {
      sessionEntry = entry;
    },
    reconfigureAlpha: (agentDir: string) => {
      config = { ...config, agents: agents(agentDir) };
    },
    request: (agentId?: string) =>
      JSON.stringify({ sessionId, prompt: "continue", cwd: stateDir, agentId }),
    stop: async () => {
      scheduler.beginClose();
      try {
        await registry.registry.services
          .find((entry) => entry.service.id === "codex-session-catalog")
          ?.service.stop?.({ config, stateDir, logger, scheduler });
      } finally {
        await scheduler.stop();
      }
    },
  };
}

function prepareBoundCatalogSession(
  fixture: Awaited<ReturnType<typeof createRegisteredResume>>,
  sourceHomeId: string | undefined,
) {
  const marker = {
    sourceHostId: "node:node-1",
    sourceThreadId: sessionId,
    nodeId: "node-1",
    ...(sourceHomeId ? { sourceHomeId } : {}),
  };
  const entry = {
    sessionId: "bound-openclaw-session",
    updatedAt: 1,
    agentHarnessId: "codex",
    modelSelectionLocked: true,
    pluginExtensions: { codex: { sessionCatalog: marker } },
  };
  fixture.setSessionEntry(entry);
  return {
    marker,
    entry,
    request: fixture.resume("agent:alpha:harness:codex:node-session:bound-catalog"),
  };
}

describe("registered Codex node resume reservations", () => {
  beforeEach(() => {
    runCommand.mockReset().mockImplementation(completeResume);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([true, false])(
    "rejects a changed or missing catalog source (pinned=%s)",
    async (pinned) => {
      const fixture = await createRegisteredResume();
      const pin = pinned ? codexCatalogHomeId(fixture.alphaHome) : undefined;
      const { request, entry, marker } = prepareBoundCatalogSession(fixture, pin);
      const savedEntry = structuredClone(entry);
      const expectPinnedHome = async () => {
        await expect(resumeCodexCliSessionOnNode(request)).resolves.toMatchObject({
          text: fixture.alphaHome,
        });
        expect(runCommand).toHaveBeenCalledOnce();
        runCommand.mockClear();
      };
      try {
        if (pinned) {
          fixture.reconfigureAlpha(fixture.aliasAgentDir);
          expect(codexCatalogHomeId(path.join(fixture.aliasAgentDir, "codex-home"))).toBe(pin);
          await expectPinnedHome();
          await fs.unlink(fixture.aliasAgentDir);
          await symlink(path.dirname(fixture.betaHome), fixture.aliasAgentDir);
          expect(await fs.realpath(path.join(fixture.aliasAgentDir, "codex-home"))).toBe(
            fixture.betaHome,
          );
          await expectPinnedHome();
          fixture.reconfigureAlpha(path.dirname(fixture.betaHome));
          expect(codexCatalogHomeId(fixture.betaHome)).not.toBe(pin);
        } else {
          expect(readNodeSessionMarker(entry)).toEqual(marker);
        }
        await expect(resumeCodexCliSessionOnNode(request)).rejects.toBeInstanceOf(Error);
        expect(runCommand).not.toHaveBeenCalled();
        if (!pinned) {
          expect(fixture.invoke).not.toHaveBeenCalled();
        }
        expect(entry).toEqual(savedEntry);
      } finally {
        await fixture.stop();
      }
    },
  );

  it("keeps unmarked slash bindings on the user home while fresh node requests select the current source", async () => {
    const fixture = await createRegisteredResume();
    fixture.setSessionEntry({ sessionId: "slash-session", updatedAt: 1 });
    fixture.reconfigureAlpha(path.dirname(fixture.betaHome));
    try {
      await expect(
        resumeCodexCliSessionOnNode(fixture.resume("agent:alpha:telegram:direct:owner")),
      ).resolves.toMatchObject({ text: fixture.alphaHome });
      expect(fixture.invoke.mock.calls[0]?.[0].params).not.toHaveProperty("agentId");
      expect(fixture.invoke.mock.calls[0]?.[0].params).not.toHaveProperty("sourceHomeId");
      expect(JSON.parse(await fixture.command.handle(fixture.request("alpha")))).toMatchObject({
        text: fixture.betaHome,
      });
    } finally {
      await fixture.stop();
    }
  });

  it("runs copied thread ids concurrently in distinct configured homes", async () => {
    const fixture = await createRegisteredResume();
    const alphaStarted = createDeferred<void>();
    const betaStarted = createDeferred<void>();
    const release = createDeferred<void>();
    runCommand.mockImplementation(async (argv, options) => {
      const home = await fs.realpath(options?.env?.CODEX_HOME ?? "");
      if (home === fixture.alphaHome) {
        alphaStarted.resolve();
      } else if (home === fixture.betaHome) {
        betaStarted.resolve();
      } else {
        throw new Error("unexpected Codex home");
      }
      await release.promise;
      return completeResume(argv, options);
    });
    let alpha: Promise<string> | undefined;
    let beta: Promise<string> | undefined;
    try {
      alpha = fixture.command.handle(fixture.request("alpha"));
      await Promise.race([alphaStarted.promise, alpha]);
      beta = fixture.command.handle(fixture.request("beta"));
      await expect(Promise.race([betaStarted.promise.then(() => "started"), beta])).resolves.toBe(
        "started",
      );
      expect(runCommand).toHaveBeenCalledTimes(2);
      release.resolve();
      expect(JSON.parse(await alpha)).toMatchObject({ text: fixture.alphaHome });
      expect(JSON.parse(await beta)).toMatchObject({ text: fixture.betaHome });
    } finally {
      release.resolve();
      await Promise.allSettled([alpha, beta]);
      await fixture.stop();
    }
  });

  it("keeps catalog and legacy home aliases mutually exclusive until a canceled turn settles", async () => {
    const fixture = await createRegisteredResume();
    const started = createDeferred<void>();
    const release = createDeferred<void>();
    runCommand.mockImplementationOnce(async (argv, options) => {
      expect(await fs.realpath(options?.env?.CODEX_HOME ?? "")).toBe(fixture.alphaHome);
      started.resolve();
      await release.promise;
      return completeResume(argv, options);
    });
    const controller = new AbortController();
    const running = fixture.command.handle(fixture.request("alpha"), undefined, {
      signal: controller.signal,
      sendNodeEvent: async () => undefined,
    });
    const outcome = running.then(
      (value) => value,
      (error: unknown) => error,
    );
    try {
      await expect(Promise.race([started.promise.then(() => "started"), outcome])).resolves.toBe(
        "started",
      );
      for (const canceled of [false, true]) {
        if (canceled) {
          controller.abort(new Error("node invocation canceled"));
        }
        for (const agentId of ["alpha", undefined]) {
          await expect(fixture.command.handle(fixture.request(agentId))).rejects.toThrow(
            "already has an active resume turn",
          );
        }
        expect(runCommand).toHaveBeenCalledOnce();
      }
      release.resolve();
      expect(await outcome).toMatchObject({ message: "node invocation canceled" });
      for (const agentId of ["alpha", undefined]) {
        expect(JSON.parse(await fixture.command.handle(fixture.request(agentId)))).toMatchObject({
          ok: true,
          text: fixture.alphaHome,
        });
      }
      expect(runCommand).toHaveBeenCalledTimes(3);
    } finally {
      release.resolve();
      await outcome;
      await fixture.stop();
    }
  });
});
