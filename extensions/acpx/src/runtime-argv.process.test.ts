import fs from "node:fs/promises";
import path from "node:path";
import {
  AcpxRuntime as BaseAcpxRuntime,
  type AcpRuntimeOptions,
  createAgentRegistry,
  createFileSessionStore,
} from "acpx/runtime";
import {
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { withOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterEach, expect, it, vi } from "vitest";
import { prepareAcpxCodexAuthConfig } from "./codex-auth-bridge.js";
import { splitCommandParts } from "./command-line.js";
import { resolveAcpxPluginConfig } from "./config.js";
import {
  createAcpxProcessLeaseStore,
  openAcpxProcessLeaseStateStore,
  readAcpxProcessLeaseIdentity,
} from "./process-lease.js";
import {
  copyNodeExecutable,
  ownerAgentScript as script,
  ownerRuntimeOptions,
  promptJson as prompt,
  fixtureSession,
  withProcessRuntime,
} from "./runtime-process.test-support.js";
import { AcpxRuntime } from "./runtime.js";
const sessionKey = "agent:main:acp:argv";
const samples = ["", "space value", `owner's "choice"`, String.raw`C:\tools\adapter`];
type Agents = Record<string, { command: string; args: string[] }>;
const agentConfig = (workspaceDir: string, agents: Agents) =>
  resolveAcpxPluginConfig({ workspaceDir, rawConfig: { agents } });

async function prepareWrappers(
  root: string,
  pluginConfig: ReturnType<typeof resolveAcpxPluginConfig>,
) {
  const codexHome = path.join(root, "empty-codex-home");
  await fs.mkdir(codexHome);
  vi.stubEnv("CODEX_HOME", codexHome);
  return prepareAcpxCodexAuthConfig({
    pluginConfig,
    stateDir: root,
  });
}

it("does not reinterpret a legacy command when a workspace file has the same name", async () => {
  await withOpenClawTestState({ label: "acpx-command-source" }, async (state) => {
    await fs.writeFile(path.join(state.root, "node --version"), "workspace content");
    const config = agentConfig(state.root, {
      fixture: { command: "node --version", args: ["suffix"] },
    });
    expect(config.agents.fixture).toEqual(["node", "--version", "suffix"]);
  });
});

afterEach(() => vi.unstubAllEnvs());

it("passes child-only environment through the ACPX process factory", async () => {
  await withProcessRuntime(
    "acpx-agent-env",
    async ({ runtime }) => {
      const handle = await runtime.ensureSession(fixtureSession(sessionKey));
      expect(await prompt(runtime, handle, "inspect")).toMatchObject({ workerThreads: "7" });
    },
    async ({ root }) => ({
      agentProcessEnv: { TOKIO_WORKER_THREADS: "7" },
      sessionStore: createFileSessionStore({ stateDir: path.join(root, "state") }),
      args: ["--capture-worker-env"],
      timeoutMs: undefined,
    }),
  );
});

it.each([
  { wrapped: true, form: "path" },
  { wrapped: false, form: "relative" },
  { wrapped: false, form: "combined" },
])(
  "preserves ACP argv through real processes and reconnect (leased=$wrapped, command=$form)",
  async ({ wrapped, form }) => {
    await withOpenClawTestState({ label: "acpx-argv-process" }, async (state) => {
      const peerDirectory = path.join(state.root, "peer");
      await fs.mkdir(peerDirectory);
      const executable = await copyNodeExecutable(state.root, "node program");
      const args = [script, peerDirectory, ...samples];
      const agent = wrapped ? "codex" : "fixture";
      const spawnExecutable =
        form === "relative" ? `.${path.sep}${path.basename(executable)}` : executable;
      const configuredCommand =
        form === "path"
          ? executable
          : `"${spawnExecutable}"${form === "combined" ? ` "${script}" "${peerDirectory}"` : ""}`;
      let config = agentConfig(state.root, {
        [agent]: { command: configuredCommand, args: form === "combined" ? samples : args },
      });
      if (wrapped) {
        config = await prepareWrappers(state.root, config);
      }
      const store = createFileSessionStore({ stateDir: config.stateDir });
      const leases = createAcpxProcessLeaseStore({
        store: openAcpxProcessLeaseStateStore((options) =>
          createPluginStateKeyedStoreForTests("acpx", {
            ...options,
            env: state.env,
          }),
        ),
      });
      const createRuntime = () =>
        new AcpxRuntime(
          ownerRuntimeOptions(state.root, {
            sessionStore: store,
            agentRegistry: createAgentRegistry({ overrides: config.agents }),
            timeoutMs: 15_000,
            openclawWrapperRoot: wrapped ? path.join(state.root, "acpx") : undefined,
            openclawGatewayInstanceId: wrapped ? "argv-test" : undefined,
            openclawProcessLeaseStore: wrapped ? leases : undefined,
          }),
        );
      let runtime = createRuntime();
      let handle: Awaited<ReturnType<AcpxRuntime["ensureSession"]>> | undefined;
      try {
        handle = await runtime.ensureSession({ ...fixtureSession(sessionKey), agent });
        const expected = { argv: samples, history: ["first"] };
        expect(await prompt(runtime, handle, "first")).toMatchObject(expected);
        const record = await store.load(handle.acpxRecordId!);
        const command = splitCommandParts(config.agents[agent]!);
        expect(record?.agentArgv?.slice(0, command.length)).toEqual(command);
        const identity = readAcpxProcessLeaseIdentity(record?.agentArgv);
        if (wrapped) {
          expect(identity?.gatewayInstanceId).toBe("argv-test");
          expect(await leases.load(identity!.leaseId)).toMatchObject({
            rootPid: record!.pid,
            sessionKey,
            state: "open",
          });
        } else {
          expect(record?.agentArgv).toEqual([spawnExecutable, ...args]);
        }
        await runtime.close({ handle, reason: "restart" });
        runtime = createRuntime();
        const resumed = await runtime.ensureSession({ ...fixtureSession(sessionKey), agent });
        expect(resumed.backendSessionId).toBe(handle.backendSessionId);
        handle = resumed;
        expected.history.push("second");
        expect(await prompt(runtime, handle, "second")).toMatchObject(expected);
        const restored = await store.load(handle.acpxRecordId!);
        expect(readAcpxProcessLeaseIdentity(restored?.agentArgv)).toEqual(identity);
      } finally {
        const closing = handle ? runtime.close({ handle, reason: "done" }) : Promise.resolve();
        await closing.finally(resetPluginStateStoreForTests);
      }
    });
  },
);

it.skipIf(process.platform === "win32")(
  "reuses an unchanged persisted POSIX scalar ACP command",
  async () => {
    await withOpenClawTestState({ label: "acpx-scalar-reuse" }, async (state) => {
      const peerDirectory = path.join(state.root, "peer");
      await fs.mkdir(peerDirectory);
      const argv = [process.execPath, script, peerDirectory];
      const scalar = argv.map((arg) => JSON.stringify(arg)).join(" ");
      const store = createFileSessionStore({ stateDir: state.root });
      const options = (command: string | string[]) =>
        ownerRuntimeOptions(state.root, {
          sessionStore: store,
          agentRegistry: createAgentRegistry({ overrides: { fixture: command } }),
        });
      const previous = new BaseAcpxRuntime(options(scalar));
      const original = await previous.ensureSession(fixtureSession(sessionKey));
      await previous.close({ handle: original, reason: "upgrade" });
      const runtime = new AcpxRuntime(options(argv));
      const handle = await runtime.ensureSession(fixtureSession(sessionKey));
      try {
        expect(handle.backendSessionId).toBe(original.backendSessionId);
        expect((await store.load(handle.acpxRecordId!))?.agentCommand).toBe(scalar);
        expect(await prompt(runtime, handle, "resumed")).toMatchObject({ history: ["resumed"] });
      } finally {
        await runtime.close({ handle, reason: "test-complete" });
      }
    });
  },
);

it("keeps generated Codex and Claude wrapper commands as portable argv", async () => {
  await withOpenClawTestState({ label: "acpx-wrapper-argv" }, async (state) => {
    const prepared = await prepareWrappers(
      state.root,
      agentConfig(state.root, {
        codex: { command: "codex-acp", args: samples },
        claude: { command: "claude-agent-acp", args: samples },
      }),
    );
    const wrapper = (agent: string) => [
      process.execPath,
      path.join(state.root, "acpx", `${agent}-acp-wrapper.mjs`),
      ...samples,
    ];
    expect(prepared.agents.codex).toEqual(wrapper("codex"));
    expect(prepared.agents.claude).toEqual(wrapper("claude-agent"));
  });
});

it("binds the prepared launch command to its selected ACP agent", async () => {
  const codex = [process.execPath, "/fixture/codex.mjs"];
  const claude = [process.execPath, "/fixture/claude.mjs"];
  const runtime = new AcpxRuntime(
    {
      cwd: process.cwd(),
      sessionStore: { load: async () => undefined, save: async () => {} },
      agentRegistry: createAgentRegistry({ overrides: { codex, claude } }),
      probeAgent: "codex",
      permissionMode: "deny-all",
    },
    {
      probeRunner: async (options: AcpRuntimeOptions) => {
        expect(options.agentRegistry.resolve("codex")).toEqual(codex);
        expect(options.agentRegistry.resolve("claude")).toEqual(claude);
        return { ok: true, message: "ready" };
      },
    },
  );
  expect(await runtime.doctor()).toMatchObject({ ok: true });
});
