import { vi } from "vitest";
import type { AcpRuntime } from "../runtime-api.js";
import { AcpxRuntime, type AcpSessionRecord, type AcpSessionStore } from "./runtime.js";
import { resolveAcpxSessionResource } from "./session-owner.js";

export type TestSessionStore = {
  load(sessionId: string): Promise<Record<string, unknown> | undefined>;
  save(record: Record<string, unknown>): Promise<void>;
};
const CODEX_ACP_WRAPPER_COMMAND = 'node "/tmp/openclaw/acpx/codex-acp-wrapper.mjs"';

export function makeRuntime(
  baseStore: TestSessionStore,
  options: Partial<ConstructorParameters<typeof AcpxRuntime>[0]> = {},
  testOptions?: ConstructorParameters<typeof AcpxRuntime>[1],
): {
  runtime: AcpxRuntime;
  wrappedStore: TestSessionStore & {
    markFresh: (sessionKey: string) => void;
  };
  delegate: {
    cancel: AcpRuntime["cancel"];
    close: AcpRuntime["close"];
    ensureSession: AcpRuntime["ensureSession"];
    startTurn: NonNullable<AcpRuntime["startTurn"]>;
    getCapabilities: NonNullable<AcpRuntime["getCapabilities"]>;
    getStatus: NonNullable<AcpRuntime["getStatus"]>;
    setMode: NonNullable<AcpRuntime["setMode"]>;
    setConfigOption: NonNullable<AcpRuntime["setConfigOption"]>;
    isHealthy(): boolean;
    probeAvailability(): Promise<void>;
    doctor(): Promise<{ ok: boolean; message: string; details?: string[] }>;
  };
} {
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
    testOptions,
  );

  return {
    runtime,
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
          cancel: AcpRuntime["cancel"];
          close: AcpRuntime["close"];
          ensureSession: AcpRuntime["ensureSession"];
          startTurn: NonNullable<AcpRuntime["startTurn"]>;
          getCapabilities: NonNullable<AcpRuntime["getCapabilities"]>;
          getStatus: NonNullable<AcpRuntime["getStatus"]>;
          setMode: NonNullable<AcpRuntime["setMode"]>;
          setConfigOption: NonNullable<AcpRuntime["setConfigOption"]>;
          isHealthy(): boolean;
          probeAvailability(): Promise<void>;
          doctor(): Promise<{ ok: boolean; message: string; details?: string[] }>;
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
