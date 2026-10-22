import type { AcpRuntimeEvent } from "@openclaw/acp-core/runtime/types";
import { createDeferred } from "../../../test/helpers/promise.js";
import { listSessionStateEventsSince } from "../../sessions/session-state-events.js";
import {
  type AcpSessionManager,
  managerFixture,
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

type TurnOptions = Omit<
  Partial<Parameters<AcpSessionManager["runTurn"]>[0]>,
  "provenance" | "mode" | "requestId" | "attachments" | "onElicitation"
>;

export function createAcceptedFixture({
  sessionKey = "agent:codex:acp:accepted-ownership",
  parented = false,
  meta = {},
}: { sessionKey?: string; parented?: boolean; meta?: Partial<SessionAcpMeta> } = {}) {
  const metadata = { currentMeta: readySessionMeta(meta) };
  const { runtimeState, ...fixture } = managerFixture(sessionKey, metadata.currentMeta);
  mockMutableSession(sessionKey, metadata);
  if (parented) {
    mockParentedAcpSessionEntries({
      childSessionKey: sessionKey,
      parentSessionKey: "agent:main:main",
      state: metadata,
    });
  }
  const run = (requestId = "turn", options: TurnOptions = {}) =>
    fixture.run({ text: "work", requestId, ...options });
  return {
    ...runtimeState,
    ...fixture,
    persisted: metadata,
    run,
    setOption: (key: string, value: string) =>
      fixture.manager.setSessionConfigOption({ ...fixture.target, key, value }),
    recordedEvents: async () =>
      (await listSessionStateEventsSince(sessionKey, "codex", 0, 200)).events,
    startTurn(requestId: string, options: TurnOptions = {}) {
      const events: AcpRuntimeEvent[] = [];
      const turn = run(requestId, {
        text: requestId,
        onEvent: (event) => void events.push(event),
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
