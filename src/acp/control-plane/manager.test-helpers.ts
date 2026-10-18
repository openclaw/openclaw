/** Shared ACP manager test harness, mocks, fixtures, and assertion helpers. */
import type {
  AcpRuntime,
  AcpRuntimeCapabilities,
  AcpRuntimeTurn,
} from "@openclaw/acp-core/runtime/types";
import { afterEach, beforeEach, expect, vi } from "vitest";
import { prepareSystemAgentRunAdmission } from "../../agents/admitted-run-context.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { AcpSessionRuntimeOptions, SessionAcpMeta } from "../../config/sessions/types.js";
import { deleteTestEnvValue, setTestEnvValue } from "../../test-utils/env.js";
import { resetAcpActiveTurnsForTests } from "./active-turns.test-support.js";
import { resolveAcpSessionTarget } from "./manager.utils.js";

export type { AcpRuntime, OpenClawConfig, SessionAcpMeta };
type MutableMeta = { currentMeta: SessionAcpMeta | undefined };

type AcpMetaUpsertInput = Parameters<
  typeof import("../runtime/session-meta.js").upsertAcpSessionMeta
>[0];
type AcpMetaUpsertObservation = Pick<
  AcpMetaUpsertInput,
  "skipMaintenance" | "takeCacheOwnership"
> & {
  next: ReturnType<AcpMetaUpsertInput["mutate"]>;
};

const hoistedMocks = vi.hoisted(() => {
  const readAcpSessionEntryMock = vi.fn();
  return {
    listAcpSessionEntriesMock: vi.fn(),
    readAcpSessionEntryMock,
    readAcpSessionEntryAsyncMock: vi.fn(async (params: unknown) => readAcpSessionEntryMock(params)),
    upsertAcpSessionMetaMock: vi.fn(),
    upsertObservations: new WeakMap<object, AcpMetaUpsertObservation>(),
    getAcpRuntimeBackendMock: vi.fn(),
    requireAcpRuntimeBackendMock: vi.fn(),
  };
});

async function mockAcpSessionMetaUpsert(params: AcpMetaUpsertInput) {
  let invoked = false;
  const observed: AcpMetaUpsertInput = {
    ...params,
    mutate: (current, entry) => {
      invoked = true;
      const next = params.mutate(current, entry);
      hoistedMocks.upsertObservations.set(observed, {
        next: structuredClone(next),
        skipMaintenance: params.skipMaintenance,
        takeCacheOwnership: params.takeCacheOwnership,
      });
      return next;
    },
  };
  const result = await hoistedMocks.upsertAcpSessionMetaMock(observed);
  // Value-only persistence fixtures still evaluate the mutation while its actor is live.
  if (!invoked) {
    const current = readySessionMeta();
    observed.mutate(current, {
      sessionId: "session-1",
      updatedAt: current.lastActivityAt,
      acp: current,
    });
  }
  return result;
}

vi.mock("../runtime/session-meta.js", () => ({
  listAcpSessionEntries: (params: unknown) => hoistedMocks.listAcpSessionEntriesMock(params),
  readAcpSessionEntry: (params: unknown) => hoistedMocks.readAcpSessionEntryMock(params),
  readAcpSessionEntryAsync: (params: unknown) => hoistedMocks.readAcpSessionEntryAsyncMock(params),
  prepareAcpSessionControlRead: async (
    params: Parameters<typeof import("../runtime/session-meta.js").prepareAcpSessionControlRead>[0],
  ) => ({
    readCurrent: async () => {
      params.assertCurrent?.();
      const stored = await hoistedMocks.readAcpSessionEntryAsyncMock(params);
      return {
        session: stored,
        entry: stored?.entry,
      };
    },
    assertCurrent: () => params.assertCurrent?.(),
    release: () => {},
  }),
  upsertAcpSessionMeta: mockAcpSessionMetaUpsert,
  upsertAcpSessionMetaForControl: mockAcpSessionMetaUpsert,
}));

vi.mock("../runtime/registry.js", () => ({
  getAcpRuntimeBackend: (backendId?: string) => hoistedMocks.getAcpRuntimeBackendMock(backendId),
  requireAcpRuntimeBackend: (backendId?: string) =>
    hoistedMocks.requireAcpRuntimeBackendMock(backendId),
}));

export const hoisted = hoistedMocks;

const managerModule = await import("./manager.js");
type AcpRunTurnInput = import("./manager.types.js").AcpRunTurnInput;
type TestAcpRunTurnInput = Omit<AcpRunTurnInput, "admittedRunContext"> &
  Partial<Pick<AcpRunTurnInput, "admittedRunContext">>;

/** Keeps production ACP admission mandatory while centralizing legacy fixture setup. */
export class AcpSessionManager extends managerModule.AcpSessionManager {
  override async runTurn(input: TestAcpRunTurnInput): Promise<void> {
    if (input.admittedRunContext) {
      return await super.runTurn({ ...input, admittedRunContext: input.admittedRunContext });
    }
    const admission = prepareSystemAgentRunAdmission(
      input.cfg,
      input.requestId,
      resolveAcpSessionTarget(input).agentId,
      "acp-manager-test",
    );
    try {
      return await super.runTurn({ ...input, admittedRunContext: await admission.admit("acp") });
    } finally {
      admission.close();
    }
  }
}
const resetAcpSessionManagerForTests = () => managerModule.testing.resetAcpSessionManagerForTests();
const managerLifecycleModule = await import("./manager.lifecycle.js");
export const disposeAcpSessionManagerInstance =
  managerLifecycleModule.disposeAcpSessionManagerInstance;
export const { AcpRuntimeError } = await import("../runtime/errors.js");

export const baseCfg = {
  acp: {
    enabled: true,
    backend: "acpx",
    dispatch: { enabled: true },
  },
} as const;
const ORIGINAL_STATE_DIR = process.env.OPENCLAW_STATE_DIR;

export async function flushMicrotasks(rounds = 3): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await Promise.resolve();
  }
}

export function expectCalledWith(mock: ReturnType<typeof vi.fn>, fields: Record<string, unknown>) {
  expect(mock).toHaveBeenCalledWith(expect.objectContaining(fields));
}

export function runtimeTurn(
  requestId: string,
  overrides: Partial<AcpRuntimeTurn> = {},
): AcpRuntimeTurn {
  return {
    requestId,
    events: (async function* () {})(),
    result: Promise.resolve({ status: "completed" }),
    cancel: vi.fn(async () => {}),
    closeStream: vi.fn(async () => {}),
    ...overrides,
  };
}

export function resolvedIdentity(overrides: Partial<NonNullable<SessionAcpMeta["identity"]>> = {}) {
  return { state: "resolved" as const, source: "status" as const, lastUpdatedAt: 1, ...overrides };
}

export function createRuntime() {
  const mocks = {
    ensureSession: vi.fn<AcpRuntime["ensureSession"]>(async (input) => ({
      sessionKey: input.sessionKey,
      backend: "acpx",
      runtimeSessionName: `${input.sessionKey}:${input.mode}:runtime`,
    })),
    runTurn: vi.fn<AcpRuntime["runTurn"]>(async function* () {
      yield { type: "done" as const };
    }),
    prepareFreshSession: vi.fn<NonNullable<AcpRuntime["prepareFreshSession"]>>(async () => {}),
    cancel: vi.fn<AcpRuntime["cancel"]>(async () => {}),
    close: vi.fn<AcpRuntime["close"]>(async () => {}),
    getCapabilities: vi.fn<NonNullable<AcpRuntime["getCapabilities"]>>(
      async (): Promise<AcpRuntimeCapabilities> => ({
        controls: ["session/set_mode", "session/set_config_option", "session/status"],
      }),
    ),
    getStatus: vi.fn<NonNullable<AcpRuntime["getStatus"]>>(async () => ({
      summary: "status=alive",
      details: { status: "alive" },
    })),
    setMode: vi.fn<NonNullable<AcpRuntime["setMode"]>>(async () => {}),
    setConfigOption: vi.fn<NonNullable<AcpRuntime["setConfigOption"]>>(async () => {}),
  };
  const runtime: AcpRuntime = { ...mocks };
  return { runtime, ...mocks };
}

export function mockMutableSession(sessionKey: string, state: MutableMeta) {
  hoisted.readAcpSessionEntryMock.mockImplementation(() => ({
    sessionKey,
    storeSessionKey: sessionKey,
    acp: state.currentMeta,
  }));
  installMutableAcpSessionMetaUpsert(state);
}

export function managerFixture(
  sessionKey = "agent:codex:acp:session-1",
  meta = readySessionMeta(),
  cfg: OpenClawConfig = baseCfg,
) {
  const runtimeState = createRuntime();
  hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
    id: "acpx",
    runtime: runtimeState.runtime,
  });
  hoisted.readAcpSessionEntryMock.mockReturnValue({
    sessionKey,
    storeSessionKey: sessionKey,
    acp: meta,
  });
  const manager = new AcpSessionManager();
  const target = { cfg, sessionKey };
  const turnInput = { ...target, provenance: "system" as const, mode: "prompt" as const };
  const run = (
    overrides: Partial<TestAcpRunTurnInput> & Pick<TestAcpRunTurnInput, "text" | "requestId">,
  ) => manager.runTurn({ ...turnInput, ...overrides });
  return { runtimeState, manager, target, run };
}

export function readySessionMeta(overrides: Partial<SessionAcpMeta> = {}): SessionAcpMeta {
  return {
    backend: "acpx",
    agent: "codex",
    runtimeSessionName: "runtime-1",
    mode: "persistent" as const,
    state: "idle" as const,
    lastActivityAt: Date.now(),
    ...overrides,
  };
}

export function mockParentedAcpSessionEntries(params: {
  childSessionKey: string;
  parentSessionKey: string;
  label?: string;
  state?: { currentMeta: SessionAcpMeta | undefined };
}): void {
  hoisted.readAcpSessionEntryMock.mockImplementation((input: unknown) => {
    const sessionKey = (input as { sessionKey?: string }).sessionKey;
    const child = sessionKey === params.childSessionKey;
    if (!child && sessionKey !== params.parentSessionKey) {
      return null;
    }
    return {
      sessionKey,
      storeSessionKey: sessionKey,
      entry: {
        sessionId: child ? "child-1" : "parent-1",
        updatedAt: Date.now(),
        ...(child
          ? {
              spawnedBy: params.parentSessionKey,
              ...(params.label === undefined ? {} : { label: params.label }),
            }
          : {}),
      },
      ...(child ? { acp: params.state ? params.state.currentMeta : readySessionMeta() } : {}),
    };
  });
}

function recordedUpserts(): AcpMetaUpsertObservation[] {
  return hoisted.upsertAcpSessionMetaMock.mock.calls.flatMap(([input]) => {
    const observation =
      input !== null && typeof input === "object"
        ? hoisted.upsertObservations.get(input)
        : undefined;
    return observation ? [observation] : [];
  });
}

export function extractStatesFromUpserts(): SessionAcpMeta["state"][] {
  return recordedUpserts().flatMap(({ next }) => (next?.state ? [next.state] : []));
}

export function extractStateUpsertPersistenceOptions() {
  return recordedUpserts().flatMap(({ next, skipMaintenance, takeCacheOwnership }) =>
    next?.state && skipMaintenance && takeCacheOwnership
      ? [{ state: next.state, skipMaintenance: true, takeCacheOwnership: true }]
      : [],
  );
}

export function extractRuntimeOptionsFromUpserts(): Array<AcpSessionRuntimeOptions | undefined> {
  return recordedUpserts().flatMap(({ next }) => (next ? [next.runtimeOptions] : []));
}

export function installAcpSessionManagerTestLifecycle(): void {
  beforeEach(() => {
    resetAcpSessionManagerForTests();
    resetAcpActiveTurnsForTests();
    vi.useRealTimers();
    hoisted.listAcpSessionEntriesMock.mockReset().mockResolvedValue([]);
    hoisted.readAcpSessionEntryMock.mockReset();
    hoisted.readAcpSessionEntryAsyncMock
      .mockReset()
      .mockImplementation(async (params: unknown) => hoisted.readAcpSessionEntryMock(params));
    hoisted.upsertObservations = new WeakMap();
    hoisted.upsertAcpSessionMetaMock.mockReset().mockResolvedValue(null);
    hoisted.requireAcpRuntimeBackendMock.mockReset();
    hoisted.getAcpRuntimeBackendMock.mockReset().mockImplementation((backendId?: string) => {
      try {
        return hoisted.requireAcpRuntimeBackendMock(backendId);
      } catch {
        return null;
      }
    });
  });

  afterEach(() => {
    if (ORIGINAL_STATE_DIR === undefined) {
      deleteTestEnvValue("OPENCLAW_STATE_DIR");
    } else {
      setTestEnvValue("OPENCLAW_STATE_DIR", ORIGINAL_STATE_DIR);
    }
  });
}

export function installMutableAcpSessionMetaUpsert(state: MutableMeta): void {
  hoisted.upsertAcpSessionMetaMock.mockImplementation(async (paramsUnknown: unknown) => {
    const params = paramsUnknown as {
      mutate: (
        current: SessionAcpMeta | undefined,
        entry: { acp?: SessionAcpMeta } | undefined,
      ) => SessionAcpMeta | null | undefined;
    };
    const next = params.mutate(state.currentMeta, { acp: state.currentMeta });
    if (next) {
      state.currentMeta = next;
    }
    return {
      sessionId: "session-1",
      updatedAt: Date.now(),
      acp: state.currentMeta,
    };
  });
}
