import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAgentRegistry, createFileSessionStore } from "acpx/runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { withOpenClawTestState, type OpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { expect } from "vitest";
import { AcpxRuntime } from "./runtime.js";

export type RuntimeHandle = Awaited<ReturnType<AcpxRuntime["ensureSession"]>>;
export type RuntimeOptions = ConstructorParameters<typeof AcpxRuntime>[0];
export type OwnerRuntimeOptions = Partial<RuntimeOptions> & { agent?: string; args?: string[] };

export function createTestGate() {
  const entered = createDeferred<void>();
  const released = createDeferred<void>();
  const release = () => released.resolve();
  return {
    entered: entered.promise,
    release,
    settle: async (...pending: (Promise<unknown> | undefined)[]) => {
      release();
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
    call: async (...args: Args) => {
      await gate.hold();
      return call(...args);
    },
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
    const store = resolved.sessionStore ?? createFileSessionStore({ stateDir: state.root });
    const runtimes: AcpxRuntime[] = [];
    const create = (overrides: Partial<RuntimeOptions> = {}) => {
      const runtime = new AcpxRuntime(
        ownerRuntimeOptions(state.root, {
          sessionStore: store,
          ...resolved,
          ...overrides,
        }),
      );
      runtimes.push(runtime);
      return runtime;
    };
    try {
      await run({ runtime: create(), state, store, directory, create });
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
  { agent = "fixture", args = [], ...overrides }: OwnerRuntimeOptions = {},
): RuntimeOptions {
  return {
    cwd: root,
    sessionStore: overrides.sessionStore ?? createFileSessionStore({ stateDir: root }),
    agentRegistry:
      overrides.agentRegistry ??
      createAgentRegistry({
        overrides: {
          [agent]: [process.execPath, ownerAgentScript, path.join(root, "peer"), ...args],
        },
      }),
    permissionMode: "deny-all",
    timeoutMs: 5000,
    ...overrides,
  };
}

export async function copyNodeExecutable(root: string, name: string) {
  const destination = path.join(root, process.platform === "win32" ? `${name}.exe` : name);
  // Symlinks preserve executable-relative libraries (including Homebrew's libnode).
  if (process.platform === "win32") {
    await fs.copyFile(process.execPath, destination);
  } else {
    await fs.symlink(process.execPath, destination);
  }
  return destination;
}

export async function promptJson(
  runtime: AcpxRuntime,
  handle: RuntimeHandle,
  text: string,
  requestId = text,
) {
  const turn = runtime.startTurn({ handle, text, mode: "prompt", requestId });
  const chunks: string[] = [];
  for await (const event of turn.events) {
    if (event.type === "text_delta") {
      chunks.push(event.text);
    }
  }
  expect(await turn.result).toMatchObject({ status: "completed" });
  return JSON.parse(chunks.join(""));
}
