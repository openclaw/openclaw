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
} from "./manager.test-helpers.js";

export const cancelledEvent = { type: "done", status: "cancelled", stopReason: "cancel" };
export function gate() {
  const entered = createDeferred();
  const release = createDeferred();
  return {
    entered: entered.promise,
    release: release.resolve,
    wait() {
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
  >
>;

export function createAcceptedFixture({
  sessionKey = "agent:codex:acp:accepted-ownership",
  parented = false,
} = {}) {
  const runtime = createRuntime();
  hoisted.requireAcpRuntimeBackendMock.mockReturnValue({ id: "acpx", runtime: runtime.runtime });
  const metadata = { currentMeta: readySessionMeta() };
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
  return {
    ...runtime,
    manager,
    target,
    async recordedEvents() {
      return (await listSessionStateEventsSince(sessionKey, "codex", 0, 200)).events;
    },
    startTurn(requestId: string, options: TurnOptions = {}) {
      const events: AcpRuntimeEvent[] = [];
      const turn = manager.runTurn({
        ...target,
        provenance: "system",
        mode: "prompt",
        text: requestId,
        requestId,
        onEvent: (event) => {
          events.push(event);
        },
        ...options,
      });
      return { turn, events };
    },
  };
}
