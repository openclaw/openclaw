import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAgentRegistry, createFileSessionStore } from "acpx/runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { withOpenClawTestState, type OpenClawTestState } from "openclaw/plugin-sdk/test-state";
import type { resolveAcpxPluginConfig } from "./config.js";
import { AcpxRuntime } from "./runtime.js";

export type RuntimeHandle = Awaited<ReturnType<AcpxRuntime["ensureSession"]>>;
export type RuntimeOptions = ConstructorParameters<typeof AcpxRuntime>[0];
export type OwnerRuntimeOptions = Partial<
  RuntimeOptions & { agent: string; args: string[]; script: string }
>;
type TurnInput = Parameters<AcpxRuntime["startTurn"]>[0];

export async function prepareTestWrappers(
  root: string,
  pluginConfig: ReturnType<typeof resolveAcpxPluginConfig>,
) {
  // This module also runs in the standalone retention child, outside Vitest.
  const { vi } = await import("vitest");
  const { prepareAcpxCodexAuthConfig } = await import("./codex-auth-bridge.js");
  const codexHome = path.join(root, "empty-codex-home");
  await fs.mkdir(codexHome);
  vi.stubEnv("CODEX_HOME", codexHome);
  return prepareAcpxCodexAuthConfig({ pluginConfig, stateDir: root });
}

export async function testProcessLeases(state: OpenClawTestState) {
  const { createAcpxProcessLeaseStore, openAcpxProcessLeaseStateStore } =
    await import("./process-lease.js");
  const { createPluginStateKeyedStoreForTests } =
    await import("openclaw/plugin-sdk/plugin-state-test-runtime");
  return createAcpxProcessLeaseStore({
    store: openAcpxProcessLeaseStateStore((options) =>
      createPluginStateKeyedStoreForTests("acpx", { ...options, env: state.env }),
    ),
  });
}

export function createTestGate() {
  const entered = createDeferred<void>();
  const released = createDeferred<void>();
  return {
    entered: entered.promise,
    release: released.resolve,
    settle: async (...pending: (Promise<unknown> | undefined)[]) => {
      released.resolve();
      await Promise.allSettled(pending.filter((operation) => operation !== undefined));
    },
    hold: async () => {
      entered.resolve();
      await released.promise;
    },
  };
}

export function createHeldCall<Args extends unknown[], Result>(
  call: (...args: Args) => Promise<Result>,
) {
  const gate = createTestGate();
  return {
    ...gate,
    call: (...args: Args) => gate.hold().then(() => call(...args)),
  };
}

export function fixtureSession(sessionKey: string, mode: "persistent" | "oneshot" = "persistent") {
  return { sessionKey, agent: "fixture", mode };
}

export function mcpServers(agentId?: string, sessionKey = "shared") {
  return ["openclaw-plugin-tools", "openclaw-tools", "user-server"].map((name) => {
    const scoped = agentId !== undefined && name !== "user-server";
    return {
      name,
      command: process.execPath,
      args: scoped ? ["server.mjs", "--openclaw-agent-id", agentId] : ["server.mjs"],
      env: scoped ? [{ name: "OPENCLAW_TOOLS_MCP_AGENT_SESSION_KEY", value: sessionKey }] : [],
    };
  });
}

export async function withProcessRuntime(
  label: string,
  run: (fixture: {
    runtime: AcpxRuntime;
    state: OpenClawTestState;
    store: ReturnType<typeof createFileSessionStore>;
    directory: string;
    create: (overrides?: Partial<RuntimeOptions>) => AcpxRuntime;
  }) => Promise<void>,
  options: OwnerRuntimeOptions | ((state: OpenClawTestState) => Promise<OwnerRuntimeOptions>) = {},
) {
  await withOpenClawTestState({ label }, async (state) => {
    const directory = path.join(state.root, "peer");
    await fs.mkdir(directory);
    const resolved = typeof options === "function" ? await options(state) : options;
    const base = ownerRuntimeOptions(state.root, resolved);
    const runtimes: AcpxRuntime[] = [];
    const create = (overrides: Partial<RuntimeOptions> = {}) => {
      const runtime = new AcpxRuntime({ ...base, ...overrides });
      runtimes.push(runtime);
      return runtime;
    };
    try {
      await run({ runtime: create(), state, store: base.sessionStore, directory, create });
    } finally {
      for (const runtime of runtimes) {
        await runtime.shutdown();
      }
    }
  });
}
export const ownerAgentScript = fileURLToPath(
  new URL("../../../test/fixtures/acp/owner-agent.mjs", import.meta.url),
);

export function ownerRuntimeOptions(
  root: string,
  options: OwnerRuntimeOptions = {},
): RuntimeOptions {
  const { agent = "fixture", args = [], script = ownerAgentScript, ...overrides } = options;
  const agentRegistry =
    overrides.agentRegistry ??
    createAgentRegistry({
      overrides: { [agent]: [process.execPath, script, path.join(root, "peer"), ...args] },
    });
  return {
    cwd: root,
    sessionStore: overrides.sessionStore ?? createFileSessionStore({ stateDir: root }),
    agentRegistry,
    permissionMode: "deny-all",
    timeoutMs: 5000,
    ...overrides,
  };
}

export async function copyNodeExecutable(root: string, name: string) {
  const destination = path.join(root, process.platform === "win32" ? `${name}.exe` : name);
  // Symlinks preserve executable-relative libraries (including Homebrew's libnode).
  await (process.platform === "win32" ? fs.copyFile : fs.symlink)(process.execPath, destination);
  return destination;
}

export async function runPrompt(runtime: AcpxRuntime, input: TurnInput) {
  const turn = runtime.startTurn(input);
  let text = "";
  for await (const event of turn.events) {
    if (event.type === "text_delta") {
      text += event.text;
    }
  }
  return { text, result: await turn.result };
}

export async function promptJson(
  runtime: AcpxRuntime,
  handle: RuntimeHandle,
  text: string,
  requestId = text,
) {
  const turn = await runPrompt(runtime, { handle, text, mode: "prompt", requestId });
  assert.equal(turn.result.status, "completed");
  return JSON.parse(turn.text);
}
