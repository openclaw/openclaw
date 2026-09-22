import { vi, type MockInstance } from "vitest";
import * as configRuntime from "../../../config/config.js";
import * as sessionAccessor from "../../../config/sessions/session-accessor.js";
import * as sessionHistory from "../../../config/sessions/session-history.js";
import * as embeddedRuns from "../../embedded-agent-runner/runs.js";
import * as deliveryRuntime from "./subagent-announce-delivery.runtime.js";
import * as announceRuntime from "./subagent-announce.runtime.js";

type AnnounceTestDeps = Pick<typeof announceRuntime, "getRuntimeConfig"> & {
  dispatchGatewayMethodInProcess: Parameters<
    MockInstance<typeof announceRuntime.dispatchGatewayMethodInProcess>["mockImplementation"]
  >[0];
  callGateway: Parameters<
    MockInstance<typeof announceRuntime.callSubagentLifecycleGateway>["mockImplementation"]
  >[0];
};

type OutputTestDeps = Pick<
  typeof announceRuntime,
  | "getRuntimeConfig"
  | "readSubagentSessionEntry"
  | "readSessionMessagesAsync"
  | "resolveAgentIdFromSessionKey"
  | "resolveSessionStorePathCore"
> & {
  callGateway: AnnounceTestDeps["callGateway"];
  findTranscriptEvent: typeof sessionAccessor.findTranscriptEvent;
  findSessionTranscriptArchiveEventReadOnly: typeof sessionHistory.findSessionTranscriptArchiveEventReadOnly;
};

export type SubagentAnnounceDeliveryTestDeps = AnnounceTestDeps & {
  getRequesterSessionActivity: typeof deliveryRuntime.getSubagentRequesterSessionActivity;
  resolveRequesterSessionAbandonment: typeof deliveryRuntime.resolveSubagentRequesterSessionAbandonment;
  loadSessionEntry: typeof sessionAccessor.loadSessionEntryReadOnly;
  loadRequesterSessionEntry: typeof deliveryRuntime.loadRequesterSessionEntry;
  queueEmbeddedAgentMessageWithOutcome: (
    ...args: Parameters<typeof embeddedRuns.queueEmbeddedAgentMessageWithOutcomeAsync>
  ) =>
    | embeddedRuns.EmbeddedAgentQueueMessageOutcome
    | Promise<embeddedRuns.EmbeddedAgentQueueMessageOutcome>;
  queueGuardedEmbeddedAgentMessageWithOutcome: typeof embeddedRuns.queueGuardedEmbeddedAgentMessageWithOutcomeAsync;
  sendMessage: typeof deliveryRuntime.sendSubagentAnnounceMessage;
};

// An exported reader spy does not replace activity's same-module lookup.
// Fixtures replacing that reader must also provide their activity observation.
type DeliveryTestOverrides = Partial<SubagentAnnounceDeliveryTestDeps> &
  (
    | { loadRequesterSessionEntry?: undefined }
    | Pick<SubagentAnnounceDeliveryTestDeps, "getRequesterSessionActivity">
  );

type Overrides = Partial<AnnounceTestDeps & OutputTestDeps & SubagentAnnounceDeliveryTestDeps>;
type Scope = "announce" | "output" | "delivery";
const scopes = new Map<Scope, Overrides>();
const restoreOverrides: Array<() => void> = [];

function install<T extends (...args: never[]) => unknown>(
  original: T,
  createSpy: () => MockInstance<T>,
  implementation: Parameters<MockInstance<T>["mockImplementation"]>[0],
) {
  if (Object.is(original, implementation)) {
    return;
  }
  const alreadyMocked = vi.isMockFunction(original);
  const spy = createSpy();
  const previous = spy.getMockImplementation();
  spy.mockImplementation(implementation);
  restoreOverrides.push(() => {
    if (!alreadyMocked) {
      spy.mockRestore();
    } else if (previous) {
      spy.mockImplementation(previous);
    } else {
      spy.mockReset();
    }
  });
}

function replaceOverrides(scope: Scope, overrides?: Overrides) {
  for (const restore of restoreOverrides.splice(0).toReversed()) {
    restore();
  }
  scopes.delete(scope);
  if (overrides) {
    const callGateway = overrides.callGateway;
    scopes.set(scope, {
      ...overrides,
      ...(scope !== "output" && callGateway && !overrides.dispatchGatewayMethodInProcess
        ? {
            dispatchGatewayMethodInProcess: (async (method, params, options) =>
              await callGateway({
                method,
                params,
                expectFinal: options?.expectFinal,
                onAccepted: options?.onAccepted,
                timeoutMs: options?.timeoutMs,
              })) satisfies AnnounceTestDeps["dispatchGatewayMethodInProcess"],
          }
        : {}),
    });
  }
  // Flow and output share imports. One spy owner restores a removed scope's
  // defaults without erasing another scope's active overrides.
  const current: Overrides = {};
  for (const entry of scopes.values()) {
    Object.assign(current, entry);
  }
  if (current.callGateway) {
    install(
      announceRuntime.callSubagentLifecycleGateway,
      () => vi.spyOn(announceRuntime, "callSubagentLifecycleGateway"),
      current.callGateway,
    );
  }
  if (current.dispatchGatewayMethodInProcess) {
    install(
      announceRuntime.dispatchGatewayMethodInProcess,
      () => vi.spyOn(announceRuntime, "dispatchGatewayMethodInProcess"),
      current.dispatchGatewayMethodInProcess,
    );
  }
  if (current.getRuntimeConfig) {
    install(
      announceRuntime.getRuntimeConfig,
      () => vi.spyOn(announceRuntime, "getRuntimeConfig"),
      current.getRuntimeConfig,
    );
    install(
      configRuntime.getRuntimeConfig,
      () => vi.spyOn(configRuntime, "getRuntimeConfig"),
      current.getRuntimeConfig,
    );
  }
  if (current.readSubagentSessionEntry) {
    install(
      announceRuntime.readSubagentSessionEntry,
      () => vi.spyOn(announceRuntime, "readSubagentSessionEntry"),
      current.readSubagentSessionEntry,
    );
  }
  if (current.readSessionMessagesAsync) {
    install(
      announceRuntime.readSessionMessagesAsync,
      () => vi.spyOn(announceRuntime, "readSessionMessagesAsync"),
      current.readSessionMessagesAsync,
    );
  }
  if (current.resolveAgentIdFromSessionKey) {
    install(
      announceRuntime.resolveAgentIdFromSessionKey,
      () => vi.spyOn(announceRuntime, "resolveAgentIdFromSessionKey"),
      current.resolveAgentIdFromSessionKey,
    );
  }
  if (current.resolveSessionStorePathCore) {
    install(
      announceRuntime.resolveSessionStorePathCore,
      () => vi.spyOn(announceRuntime, "resolveSessionStorePathCore"),
      current.resolveSessionStorePathCore,
    );
  }
  if (current.findTranscriptEvent) {
    install(
      sessionAccessor.findTranscriptEvent,
      () => vi.spyOn(sessionAccessor, "findTranscriptEvent"),
      current.findTranscriptEvent,
    );
  }
  if (current.findSessionTranscriptArchiveEventReadOnly) {
    install(
      sessionHistory.findSessionTranscriptArchiveEventReadOnly,
      () => vi.spyOn(sessionHistory, "findSessionTranscriptArchiveEventReadOnly"),
      current.findSessionTranscriptArchiveEventReadOnly,
    );
  }
  if (current.loadSessionEntry) {
    install(
      sessionAccessor.loadSessionEntryReadOnly,
      () => vi.spyOn(sessionAccessor, "loadSessionEntryReadOnly"),
      current.loadSessionEntry,
    );
  }
  if (current.loadRequesterSessionEntry) {
    install(
      deliveryRuntime.loadRequesterSessionEntry,
      () => vi.spyOn(deliveryRuntime, "loadRequesterSessionEntry"),
      current.loadRequesterSessionEntry,
    );
  }
  if (current.getRequesterSessionActivity) {
    install(
      deliveryRuntime.getSubagentRequesterSessionActivity,
      () => vi.spyOn(deliveryRuntime, "getSubagentRequesterSessionActivity"),
      current.getRequesterSessionActivity,
    );
  }
  if (current.resolveRequesterSessionAbandonment) {
    install(
      deliveryRuntime.resolveSubagentRequesterSessionAbandonment,
      () => vi.spyOn(deliveryRuntime, "resolveSubagentRequesterSessionAbandonment"),
      current.resolveRequesterSessionAbandonment,
    );
  }
  const queue = current.queueEmbeddedAgentMessageWithOutcome;
  if (queue) {
    install(
      embeddedRuns.queueEmbeddedAgentMessageWithOutcomeAsync,
      () => vi.spyOn(embeddedRuns, "queueEmbeddedAgentMessageWithOutcomeAsync"),
      async (...args) => await queue(...args),
    );
  }
  if (current.queueGuardedEmbeddedAgentMessageWithOutcome) {
    install(
      embeddedRuns.queueGuardedEmbeddedAgentMessageWithOutcomeAsync,
      () => vi.spyOn(embeddedRuns, "queueGuardedEmbeddedAgentMessageWithOutcomeAsync"),
      current.queueGuardedEmbeddedAgentMessageWithOutcome,
    );
  }
  if (current.sendMessage) {
    install(
      deliveryRuntime.sendSubagentAnnounceMessage,
      () => vi.spyOn(deliveryRuntime, "sendSubagentAnnounceMessage"),
      current.sendMessage,
    );
  }
}

export const announceTesting = {
  setDepsForTest: (overrides?: Partial<AnnounceTestDeps>) =>
    replaceOverrides("announce", overrides),
};

export const outputTesting = {
  setDepsForTest: (overrides?: Partial<OutputTestDeps>) => replaceOverrides("output", overrides),
};

export function setSubagentAnnounceDeliveryDepsForTest(overrides?: DeliveryTestOverrides) {
  replaceOverrides("delivery", overrides);
}
