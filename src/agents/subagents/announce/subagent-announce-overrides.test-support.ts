import { vi, type MockInstance } from "vitest";
import * as configRuntime from "../../../config/config.js";
import * as sessionAccessor from "../../../config/sessions/session-accessor.js";
import * as sessionEntryWorker from "../../../config/sessions/session-entry-read-runtime.js";
import * as sessionHistory from "../../../config/sessions/session-history.js";
import { withSessionTurn } from "../../../sessions/session-controller.admission.js";
import { adoptSessionControllerSource } from "../../../sessions/session-controller.mailbox.js";
import * as sessionQueries from "../../../sessions/session-controller.queries.js";
import * as embeddedRuns from "../../embedded-agent-runner/runs.js";
import * as deliveryRuntime from "./subagent-announce-delivery.runtime.js";
import * as announceRuntime from "./subagent-announce.runtime.js";

type Implementation<T extends (...args: never[]) => unknown> = Parameters<
  MockInstance<T>["mockImplementation"]
>[0];
type AnnounceTestDeps = Pick<typeof announceRuntime, "getRuntimeConfig"> & {
  dispatchGatewayMethodInProcess: Implementation<
    typeof announceRuntime.dispatchGatewayMethodInProcess
  >;
  callGateway: Implementation<typeof announceRuntime.callSubagentLifecycleGateway>;
};

type OutputTestDeps = Pick<
  typeof announceRuntime,
  "getRuntimeConfig" | "readSessionMessagesAsync" | "resolveSessionStorePathCore"
> & {
  readSubagentSessionEntry: (
    ...args: Parameters<typeof announceRuntime.readSubagentSessionEntry>
  ) =>
    | ReturnType<typeof announceRuntime.readSubagentSessionEntry>
    | Awaited<ReturnType<typeof announceRuntime.readSubagentSessionEntry>>;
  callGateway: AnnounceTestDeps["callGateway"];
  findTranscriptEvent: typeof sessionAccessor.findTranscriptEvent;
  findSessionTranscriptArchiveEventReadOnly: typeof sessionHistory.findSessionTranscriptArchiveEventReadOnly;
};

export type SubagentAnnounceDeliveryTestDeps = AnnounceTestDeps & {
  getRequesterSessionActivity: typeof deliveryRuntime.getSubagentRequesterSessionActivity;
  isSessionRunActive: typeof sessionQueries.isSessionRunActive;
  resolveRequesterSessionAbandonment: typeof embeddedRuns.resolveEmbeddedRunAbandonment;
  loadSessionEntry: typeof sessionAccessor.loadSessionEntryReadOnly;
  loadSessionEntryByKey: typeof deliveryRuntime.loadSessionEntryByKey;
  loadRequesterSessionEntry: (
    ...args: Parameters<typeof deliveryRuntime.loadRequesterSessionEntry>
  ) => Awaited<ReturnType<typeof deliveryRuntime.loadRequesterSessionEntry>>;
  sendMessage: typeof deliveryRuntime.sendSubagentAnnounceMessage;
};

type DeliveryTestOverrides = Partial<SubagentAnnounceDeliveryTestDeps>;

type Overrides = Partial<AnnounceTestDeps & OutputTestDeps & SubagentAnnounceDeliveryTestDeps>;
type Scope = "announce" | "output" | "delivery";
const scopes = new Map<Scope, Overrides>();
const restoreOverrides: Array<() => void> = [];

/** Exercise reserved-source adoption when a test replaces the in-process Gateway adapter. */
async function dispatchThroughTestGateway(
  callGateway: AnnounceTestDeps["callGateway"],
  method: string,
  params: Record<string, unknown>,
  options: Parameters<typeof announceRuntime.dispatchGatewayMethodInProcess>[2],
) {
  const dispatch = () =>
    callGateway({
      method,
      params,
      expectFinal: options?.expectFinal,
      onAccepted: options?.onAccepted,
      timeoutMs: options?.timeoutMs,
    });
  const controllerInput = method === "agent" ? options?.controllerInput : undefined;
  if (!controllerInput) {
    return await dispatch();
  }
  const runId = typeof params.idempotencyKey === "string" ? params.idempotencyKey : undefined;
  const target = controllerInput.target ?? controllerInput.mailbox.owner.target;
  if (!runId || !target) {
    throw new Error("Reserved announce source requires its run and physical target");
  }
  adoptSessionControllerSource(controllerInput, {
    target,
    policy: controllerInput.policy,
    protocolRunId: runId,
    adapter: {},
  });
  if (options?.expectFinal === true) {
    options.onAccepted?.({ status: "accepted", runId });
  }
  return await withSessionTurn(
    {
      sessionKey: controllerInput.mailbox.key,
      sessionId: controllerInput.sourceSessionId ?? target.incarnation,
      agentId: target.agentId,
      target,
      controllerInput,
    },
    dispatch,
  );
}

type Callable = Extract<NonNullable<Parameters<typeof vi.fn>[0]>, (...args: never[]) => unknown>;
type MethodKeys<T> = keyof { [K in keyof T as T[K] extends Callable ? K : never]: T[K] };
function install<T extends object, K extends keyof T & MethodKeys<Required<T>>>(owner: T, key: K) {
  const createSpy = () => vi.spyOn(owner, key);
  return (implementation?: Parameters<ReturnType<typeof createSpy>["mockImplementation"]>[0]) => {
    const original = owner[key];
    if (!implementation || Object.is(original, implementation)) {
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
  };
}

function replaceOverrides(scope: Scope, overrides?: Overrides) {
  for (const restore of restoreOverrides.splice(0).toReversed()) {
    restore();
  }
  scopes.delete(scope);
  if (overrides) {
    const entry = { ...overrides };
    const callGateway = entry.callGateway;
    if (scope !== "output" && callGateway && !entry.dispatchGatewayMethodInProcess) {
      entry.dispatchGatewayMethodInProcess = async (method, params, options) =>
        await dispatchThroughTestGateway(callGateway, method, params, options);
    }
    scopes.set(scope, entry);
  }
  // Flow and output share imports. One spy owner restores a removed scope's
  // defaults without erasing another scope's active overrides.
  const current: Overrides = {};
  for (const entry of scopes.values()) {
    Object.assign(current, entry);
  }
  install(announceRuntime, "callSubagentLifecycleGateway")(current.callGateway);
  install(
    announceRuntime,
    "dispatchGatewayMethodInProcess",
  )(current.dispatchGatewayMethodInProcess);
  install(announceRuntime, "getRuntimeConfig")(current.getRuntimeConfig);
  install(configRuntime, "getRuntimeConfig")(current.getRuntimeConfig);
  if (current.readSubagentSessionEntry) {
    install(
      announceRuntime,
      "readSubagentSessionEntry",
    )(async (...args) => current.readSubagentSessionEntry!(...args));
  }
  install(announceRuntime, "readSessionMessagesAsync")(current.readSessionMessagesAsync);
  install(announceRuntime, "resolveSessionStorePathCore")(current.resolveSessionStorePathCore);
  install(sessionAccessor, "findTranscriptEvent")(current.findTranscriptEvent);
  install(
    sessionHistory,
    "findSessionTranscriptArchiveEventReadOnly",
  )(current.findSessionTranscriptArchiveEventReadOnly);
  if (current.loadSessionEntry) {
    install(sessionAccessor, "loadSessionEntryReadOnly")(current.loadSessionEntry);
    install(
      sessionEntryWorker,
      "readSessionEntryReadOnlyInWorker",
    )(async (readScope, assertCurrent) => {
      assertCurrent?.();
      return current.loadSessionEntry!(readScope);
    });
    install(
      sessionEntryWorker,
      "withSessionEntryReadOnlyInWorker",
    )(async (readScope, assertCurrent, consume) => {
      assertCurrent();
      const result = await consume(
        { ok: true, value: current.loadSessionEntry!(readScope) },
        { kind: "file", assertCurrent },
      );
      assertCurrent();
      return result;
    });
  }
  if (current.loadRequesterSessionEntry) {
    install(
      deliveryRuntime,
      "loadRequesterSessionEntry",
    )(async (...args) => current.loadRequesterSessionEntry!(...args));
    install(
      deliveryRuntime,
      "captureRequesterSessionEntryCurrent",
    )(async (...args) => ({
      readCurrent: () => current.loadRequesterSessionEntry!(...args).entry,
      release() {},
    }));
  }
  install(deliveryRuntime, "loadSessionEntryByKey")(current.loadSessionEntryByKey);
  install(
    deliveryRuntime,
    "getSubagentRequesterSessionActivity",
  )(current.getRequesterSessionActivity);
  install(sessionQueries, "isSessionRunActive")(current.isSessionRunActive);
  install(
    embeddedRuns,
    "resolveEmbeddedRunAbandonment",
  )(current.resolveRequesterSessionAbandonment);
  install(deliveryRuntime, "sendSubagentAnnounceMessage")(current.sendMessage);
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
