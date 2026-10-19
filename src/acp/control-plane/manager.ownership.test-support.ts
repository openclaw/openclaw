import type { AcpRuntimeEvent } from "@openclaw/acp-core/runtime/types";
import { createDeferred } from "../../../test/helpers/promise.js";
import { listSessionStateEventsSince } from "../../sessions/session-state-events.js";
import {
  AcpSessionManager,
  baseCfg,
  createRuntime,
  hoisted,
  mockMutableSession,
  mockParentedAcpSessionEntries,
  readySessionMeta,
  type SessionAcpMeta,
} from "./manager.test-helpers.js";

export const cancelledEvent = { type: "done", status: "cancelled", stopReason: "cancel" };
export function gate() {
  const entered = createDeferred();
  const release = createDeferred();
  return {
    entered: entered.promise,
    release: release.resolve,
    wait: () => {
      entered.resolve();
      return release.promise;
    },
  };
}

type TurnOptions = Partial<
  Pick<
    Parameters<AcpSessionManager["runTurn"]>[0],
    | "text"
    | "signal"
    | "admittedRunContext"
    | "cfg"
    | "agentId"
    | "sessionKey"
    | "onBeforePrompt"
    | "onLifecycle"
    | "onEvent"
  >
>;

export function createAcceptedFixture({
  sessionKey = "agent:codex:acp:accepted-ownership",
  parented = false,
  meta = {},
}: { sessionKey?: string; parented?: boolean; meta?: Partial<SessionAcpMeta> } = {}) {
  const runtime = createRuntime();
  hoisted.requireAcpRuntimeBackendMock.mockReturnValue({ id: "acpx", runtime: runtime.runtime });
  const metadata = { currentMeta: readySessionMeta(meta) };
  mockMutableSession(sessionKey, metadata);
  if (parented) {
    mockParentedAcpSessionEntries({
      childSessionKey: sessionKey,
      parentSessionKey: "agent:main:main",
      state: metadata,
    });
  }
  const manager = new AcpSessionManager();
  const target = { cfg: baseCfg, sessionKey };
  const run = (requestId = "turn", options: TurnOptions = {}) =>
    manager.runTurn({
      ...target,
      provenance: "system",
      mode: "prompt",
      text: "work",
      requestId,
      ...options,
    });
  return {
    ...runtime,
    manager,
    target,
    persisted: metadata,
    run,
    setOption: (key: string, value: string) =>
      manager.setSessionConfigOption({ ...target, key, value }),
    async recordedEvents() {
      return (await listSessionStateEventsSince(sessionKey, "codex", 0, 200)).events;
    },
    startTurn(requestId: string, options: TurnOptions = {}) {
      const events: AcpRuntimeEvent[] = [];
      const turn = run(requestId, {
        text: requestId,
        onEvent: (event) => {
          events.push(event);
        },
        ...options,
      });
      return { turn, events };
    },
  };
}

export function createRuntimeConfigFixture(meta: Partial<SessionAcpMeta> = {}) {
  return createAcceptedFixture({
    sessionKey: `agent:${meta.agent ?? "codex"}:acp:runtime-config`,
    meta,
  });
}
