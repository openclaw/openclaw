import type {
  AcpxRuntime as UpstreamRuntime,
  AcpSessionRecord,
  AcpSessionStore,
  AcpRuntimeOptions,
  AcpProcessLaunch,
} from "acpx/runtime";
import { vi } from "vitest";
import type { AcpRuntime, AcpRuntimeTurn } from "../runtime-api.js";
import { splitCommandParts, type AcpxAgentCommand } from "./command-line.js";
import { AcpxRuntime } from "./runtime.js";
import { resolveAcpxSessionResource } from "./session-owner.js";

export type TestSessionStore = {
  load(sessionId: string): Promise<Record<string, unknown> | undefined>;
  save(record: Record<string, unknown>): Promise<void>;
};
export const CODEX_ACP_WRAPPER_COMMAND = 'node "/tmp/openclaw/acpx/codex-acp-wrapper.mjs"';

export function makeRuntime(
  baseStore: TestSessionStore,
  options: Partial<ConstructorParameters<typeof AcpxRuntime>[0]> = {},
  testOptions?: ConstructorParameters<typeof AcpxRuntime>[1],
): {
  runtime: AcpxRuntime;
  probe: ReturnType<
    typeof vi.fn<(options: AcpRuntimeOptions) => Promise<{ ok: boolean; message: string }>>
  >;
  wrappedStore: TestSessionStore & {
    markFresh: (sessionKey: string) => void;
  };
  delegate: {
    shutdown(): Promise<void>;
    cancel: AcpRuntime["cancel"];
    close: AcpRuntime["close"];
    ensureSession: AcpRuntime["ensureSession"];
    startTurn: NonNullable<AcpRuntime["startTurn"]>;
    getCapabilities: UpstreamRuntime["getCapabilities"];
    getStatus: NonNullable<AcpRuntime["getStatus"]>;
    setMode: NonNullable<AcpRuntime["setMode"]>;
    setConfigOption: NonNullable<AcpRuntime["setConfigOption"]>;
  };
} {
  const probe = vi.fn(async (_options: AcpRuntimeOptions) => ({ ok: true, message: "ready" }));
  const runtime = new AcpxRuntime(
    {
      cwd: "/tmp",
      sessionStore: baseStore as unknown as AcpSessionStore,
      agentRegistry: {
        resolve: (agentName: string) => (agentName === "openclaw" ? "openclaw acp" : agentName),
        list: () => ["codex", "openclaw"],
      },
      permissionMode: "approve-reads",
      ...options,
    },
    { probeRunner: probe, ...testOptions },
  );

  return {
    runtime,
    probe,
    wrappedStore: (
      runtime as unknown as {
        sessionStore: TestSessionStore & {
          markFresh: (sessionKey: string) => void;
        };
      }
    ).sessionStore,
    delegate: (
      runtime as unknown as {
        delegate: {
          shutdown(): Promise<void>;
          cancel: AcpRuntime["cancel"];
          close: AcpRuntime["close"];
          ensureSession: AcpRuntime["ensureSession"];
          startTurn: NonNullable<AcpRuntime["startTurn"]>;
          getCapabilities: UpstreamRuntime["getCapabilities"];
          getStatus: NonNullable<AcpRuntime["getStatus"]>;
          setMode: NonNullable<AcpRuntime["setMode"]>;
          setConfigOption: NonNullable<AcpRuntime["setConfigOption"]>;
        };
      }
    ).delegate,
  };
}

export function makeManagedRuntime() {
  const target = { sessionKey: "shared-project", agentId: "main" };
  const resource = resolveAcpxSessionResource(target);
  const pid = process.pid + 1;
  let record: AcpSessionRecord = {
    schema: "acpx.session.v1",
    name: resource,
    acpxRecordId: resource,
    acpSessionId: "managed-delegate-session",
    agentCommand: CODEX_ACP_WRAPPER_COMMAND,
    cwd: "/tmp",
    pid,
    closed: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    lastUsedAt: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    lastSeq: 0,
    messages: [],
    cumulative_token_usage: {},
    request_token_usage: {},
    eventLog: {
      active_path: "unused.jsonl",
      segment_count: 0,
      max_segment_bytes: 1024,
      max_segments: 1,
    },
  };
  const baseStore = {
    load: vi.fn(async () => structuredClone(record)),
    save: vi.fn(async (next: AcpSessionRecord) => {
      record = structuredClone(next);
    }),
  };
  const sleep = vi.fn(async () => {});
  const runtime = new AcpxRuntime(
    {
      cwd: "/tmp",
      sessionStore: baseStore,
      permissionMode: "deny-all",
      agentRegistry: { resolve: () => CODEX_ACP_WRAPPER_COMMAND, list: () => ["fixture"] },
      openclawToolsMcpBridgeEnabled: true,
      openclawWrapperRoot: "/tmp/openclaw/acpx",
      mcpServers: [{ name: "openclaw-tools", command: "node", args: [], env: [] }],
    },
    {
      openclawProcessCleanup: {
        platform: "linux",
        listProcesses: async () => [{ pid, ppid: 1, command: CODEX_ACP_WRAPPER_COMMAND }],
        killProcess: vi.fn(),
        sleep,
      },
    },
  );
  return {
    runtime,
    target,
    resource,
    baseStore,
    sleep,
    ensure: () => runtime.ensureSession({ ...target, agent: "fixture", mode: "persistent" }),
  };
}

export function makeEmptySessionStore(): TestSessionStore {
  return {
    load: vi.fn(async () => undefined),
    save: vi.fn(async () => {}),
  };
}

export function makeTurn(
  input: { requestId: string },
  overrides: Partial<AcpRuntimeTurn> = {},
): AcpRuntimeTurn {
  return {
    requestId: input.requestId,
    promptStarted: Promise.resolve(),
    events: (async function* () {})(),
    result: Promise.resolve({ status: "completed" }),
    cancel: vi.fn(async () => {}),
    closeStream: vi.fn(async () => {}),
    ...overrides,
  };
}

export function runtimeCommand(runtime: AcpxRuntime): AcpxAgentCommand {
  const registry: { resolve(agent: string): AcpxAgentCommand } = Reflect.get(
    runtime,
    "scopedAgentRegistry",
  );
  return registry.resolve("codex");
}

export async function observeLaunch(
  runtime: AcpxRuntime,
  input: { sessionKey?: string; command?: AcpxAgentCommand; pid?: number } = {},
) {
  const delegate = Reflect.get(runtime, "delegate");
  const options: AcpRuntimeOptions = Reflect.get(delegate, "options");
  const lifecycle = options.processLifecycle;
  if (!lifecycle?.onBeforeSpawn || !lifecycle.onSpawned) {
    throw new Error("Expected runtime process lifecycle hooks");
  }
  const parts = splitCommandParts(input.command ?? runtimeCommand(runtime));
  const launch: AcpProcessLaunch = {
    launchId: "fixture-launch",
    command: parts[0]!,
    args: parts.slice(1),
    cwd: "/tmp",
    scope: input.sessionKey
      ? { kind: "runtime-session", sessionKey: input.sessionKey }
      : { kind: "runtime-probe", agent: "codex" },
  };
  await lifecycle.onBeforeSpawn(launch);
  if (input.pid !== undefined) {
    await lifecycle.onSpawned({ ...launch, pid: input.pid, startedAt: new Date().toISOString() });
  }
}

export function makeLeaseStore() {
  const leases = new Map<string, Record<string, unknown>>();
  return {
    leases,
    store: {
      load: vi.fn(async (leaseId: string) => leases.get(leaseId) as never),
      listOpen: vi.fn(async () => Array.from(leases.values()) as never),
      save: vi.fn(async (lease: Record<string, unknown>) => {
        leases.set(String(lease.leaseId), lease);
      }),
      markState: vi.fn(async (leaseId: string, state: string) => {
        if (state === "closed" || state === "lost") {
          leases.delete(leaseId);
          return;
        }
        const lease = leases.get(leaseId);
        if (lease) {
          lease.state = state;
        }
      }),
    },
  };
}

export function makeLeasedRuntime(
  baseStore: TestSessionStore,
  leases: ReturnType<typeof makeLeaseStore>,
) {
  return makeRuntime(baseStore, {
    openclawGatewayInstanceId: "gateway-test",
    openclawProcessLeaseStore: leases.store,
    openclawWrapperRoot: "/tmp/openclaw/acpx",
    agentRegistry: {
      resolve: (agent) => (agent === "codex" ? CODEX_ACP_WRAPPER_COMMAND : agent),
      list: () => ["codex"],
    },
  });
}
