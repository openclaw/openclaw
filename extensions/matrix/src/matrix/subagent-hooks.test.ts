import type { OpenClawPluginApi as MatrixEntryPluginApi } from "openclaw/plugin-sdk/channel-entry-contract";
import {
  getRequiredHookHandler,
  registerHookHandlersForTest,
} from "openclaw/plugin-sdk/channel-test-helpers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerMatrixSubagentHooks } from "../../subagent-hooks-api.js";

const mocks = vi.hoisted(() => ({
  unbindMock: vi.fn(),
  getManagerMock: vi.fn(),
  listAllBindingsMock: vi.fn((): ReturnType<typeof makeBinding>[] => []),
  listBindingsForAccountMock: vi.fn((): ReturnType<typeof makeBinding>[] => []),
  removeBindingsMock: vi.fn(async () => []),
}));
const {
  unbindMock,
  getManagerMock,
  listAllBindingsMock,
  listBindingsForAccountMock,
  removeBindingsMock,
} = mocks;

vi.mock("openclaw/plugin-sdk/conversation-binding-runtime", () => ({
  getSessionBindingService: () => ({ unbind: mocks.unbindMock }),
}));

// mock-isolation: Hook fixtures own binding indexes and managers independently of process-global bindings.
vi.mock("./thread-bindings-shared.js", () => ({
  getMatrixThreadBindingManager: mocks.getManagerMock,
  listAllBindings: mocks.listAllBindingsMock,
  listBindingsForAccount: mocks.listBindingsForAccountMock,
  resolveBindingKey: (params: {
    accountId: string;
    conversationId: string;
    parentConversationId?: string;
  }) =>
    `${params.accountId}:${params.parentConversationId?.trim() || "-"}:${params.conversationId}`,
}));

import { handleMatrixSubagentDeliveryTarget, handleMatrixSubagentEnded } from "./subagent-hooks.js";
import type { MatrixThreadBindingRecord } from "./thread-bindings-shared.js";

const CHILD_SESSION_KEY = "agent:ops:subagent:child";
const ROOM_ID = "!room:example";

function makeBinding(overrides: Partial<MatrixThreadBindingRecord> = {}) {
  return {
    targetSessionKey: CHILD_SESSION_KEY,
    targetKind: "subagent",
    accountId: "ops",
    conversationId: "$thread",
    parentConversationId: ROOM_ID,
    boundAt: 0,
    lastActivityAt: 0,
    ...overrides,
  };
}

const targetOrigin = { channel: "matrix", accountId: "ops", to: `room:${ROOM_ID}` };
const deliveryTarget = (threadId?: string) => ({
  origin: { ...targetOrigin, ...(threadId ? { threadId } : {}) },
});

beforeEach(() => {
  for (const mock of Object.values(mocks)) {
    mock.mockReset();
  }
});

function makeDeliveryEvent(
  overrides: Partial<Parameters<typeof handleMatrixSubagentDeliveryTarget>[0]> = {},
) {
  return {
    childSessionKey: CHILD_SESSION_KEY,
    requesterOrigin: { channel: "matrix", accountId: "ops" },
    expectsCompletionMessage: true,
    ...overrides,
  };
}

it("matrix subagent hook registration: resolves delivery targets through the lazy registration barrel", async () => {
  listBindingsForAccountMock.mockReturnValue([makeBinding()]);
  const handlers = registerHookHandlersForTest<MatrixEntryPluginApi>({
    config: {},
    register: registerMatrixSubagentHooks,
  });
  const handler = getRequiredHookHandler(handlers, "subagent_delivery_target");

  await expect(handler(makeDeliveryEvent(), {})).resolves.toEqual(deliveryTarget("$thread"));
});

describe("handleMatrixSubagentDeliveryTarget", () => {
  it("returns undefined when completion delivery is not requested", () => {
    expect(
      handleMatrixSubagentDeliveryTarget(makeDeliveryEvent({ expectsCompletionMessage: false })),
    ).toBeUndefined();
  });

  it("returns undefined for another channel or a missing binding", () => {
    expect(
      handleMatrixSubagentDeliveryTarget(
        makeDeliveryEvent({ requesterOrigin: { channel: "discord", accountId: "ops" } }),
      ),
    ).toBeUndefined();
    expect(handleMatrixSubagentDeliveryTarget(makeDeliveryEvent())).toBeUndefined();
  });

  it("omits threadId for a top-level room binding", () => {
    listBindingsForAccountMock.mockReturnValue([
      makeBinding({ conversationId: ROOM_ID, parentConversationId: ROOM_ID }),
    ]);

    expect(handleMatrixSubagentDeliveryTarget(makeDeliveryEvent())).toEqual(deliveryTarget());
  });

  it("fails closed when multiple bindings do not match the requester thread", () => {
    listBindingsForAccountMock.mockReturnValue([
      makeBinding({ conversationId: "$thread-1" }),
      makeBinding({ conversationId: "$thread-2" }),
    ]);

    expect(
      handleMatrixSubagentDeliveryTarget(
        makeDeliveryEvent({
          requesterOrigin: { channel: "matrix", accountId: "ops", threadId: "$other" },
        }),
      ),
    ).toBeUndefined();
  });

  it("scans all bindings when requester accountId is absent", () => {
    listAllBindingsMock.mockReturnValue([makeBinding()]);

    expect(
      handleMatrixSubagentDeliveryTarget(
        makeDeliveryEvent({ requesterOrigin: { channel: "matrix" } }),
      ),
    ).toEqual(deliveryTarget("$thread"));
    expect(listAllBindingsMock).toHaveBeenCalledTimes(1);
    expect(listBindingsForAccountMock).not.toHaveBeenCalled();
  });
});

describe("handleMatrixSubagentEnded", () => {
  it("removes matching bindings and persists each affected account once", async () => {
    listBindingsForAccountMock.mockReturnValue([
      makeBinding(),
      makeBinding({ targetSessionKey: "agent:ops:subagent:other" }),
    ]);
    getManagerMock.mockReturnValue({ removeBindingsAsync: removeBindingsMock });

    await handleMatrixSubagentEnded({
      targetSessionKey: CHILD_SESSION_KEY,
      targetKind: "subagent",
      accountId: "ops",
    });

    expect(removeBindingsMock).toHaveBeenCalledExactlyOnceWith([makeBinding()]);
  });

  it("uses the binding service for requested farewell cleanup", async () => {
    const binding = makeBinding();
    listBindingsForAccountMock.mockReturnValue([binding]);
    unbindMock.mockResolvedValue([{ ...binding, bindingId: "ops:!room:example:$thread" }]);

    await handleMatrixSubagentEnded({
      targetSessionKey: CHILD_SESSION_KEY,
      targetKind: "subagent",
      accountId: "ops",
      reason: "subagent-complete",
      sendFarewell: true,
    });

    expect(unbindMock).toHaveBeenCalledWith({
      bindingId: "ops:!room:example:$thread",
      reason: "subagent-complete",
      scope: { channel: "matrix", accountId: "ops" },
    });
    expect(removeBindingsMock).not.toHaveBeenCalled();
  });
});
