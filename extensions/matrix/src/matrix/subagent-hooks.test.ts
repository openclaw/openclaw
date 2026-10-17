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

vi.mock("openclaw/plugin-sdk/conversation-binding-runtime", () => ({
  getSessionBindingService: () => ({ unbind: mocks.unbindMock }),
}));

// mock-isolation: Hook fixtures own binding indexes and managers independently of process-global bindings.
vi.mock("./thread-bindings-shared.js", () => ({
  getMatrixThreadBindingManager: mocks.getManagerMock,
  listAllBindings: mocks.listAllBindingsMock,
  listBindingsForAccount: mocks.listBindingsForAccountMock,
  resolveBindingKey: (
    params: Pick<
      MatrixThreadBindingRecord,
      "accountId" | "conversationId" | "parentConversationId"
    >,
  ) => `${params.accountId}:${params.parentConversationId?.trim() || "-"}:${params.conversationId}`,
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
  requesterOrigin: Parameters<typeof handleMatrixSubagentDeliveryTarget>[0]["requesterOrigin"] = {
    channel: "matrix",
    accountId: "ops",
  },
  expectsCompletionMessage = true,
) {
  return {
    childSessionKey: CHILD_SESSION_KEY,
    requesterOrigin,
    expectsCompletionMessage,
  };
}
const deliver = (...args: Parameters<typeof makeDeliveryEvent>) =>
  handleMatrixSubagentDeliveryTarget(makeDeliveryEvent(...args));

it("matrix subagent hook registration: resolves delivery targets through the lazy registration barrel", async () => {
  mocks.listBindingsForAccountMock.mockReturnValue([makeBinding()]);
  const handlers = registerHookHandlersForTest<MatrixEntryPluginApi>({
    config: {},
    register: registerMatrixSubagentHooks,
  });
  const handler = getRequiredHookHandler(handlers, "subagent_delivery_target");

  await expect(handler(makeDeliveryEvent(), {})).resolves.toEqual(deliveryTarget("$thread"));
});

describe("handleMatrixSubagentDeliveryTarget", () => {
  it("returns undefined when completion delivery is not requested", () => {
    expect(deliver(undefined, false)).toBeUndefined();
  });

  it("returns undefined for another channel or a missing binding", () => {
    expect(deliver({ channel: "discord", accountId: "ops" })).toBeUndefined();
    expect(deliver()).toBeUndefined();
  });

  it("omits threadId for a top-level room binding", () => {
    mocks.listBindingsForAccountMock.mockReturnValue([
      makeBinding({ conversationId: ROOM_ID, parentConversationId: ROOM_ID }),
    ]);

    expect(deliver()).toEqual(deliveryTarget());
  });

  it("fails closed when multiple bindings do not match the requester thread", () => {
    mocks.listBindingsForAccountMock.mockReturnValue([
      makeBinding({ conversationId: "$thread-1" }),
      makeBinding({ conversationId: "$thread-2" }),
    ]);

    expect(deliver({ channel: "matrix", accountId: "ops", threadId: "$other" })).toBeUndefined();
  });

  it("scans all bindings when requester accountId is absent", () => {
    mocks.listAllBindingsMock.mockReturnValue([makeBinding()]);

    expect(deliver({ channel: "matrix" })).toEqual(deliveryTarget("$thread"));
    expect(mocks.listAllBindingsMock).toHaveBeenCalledTimes(1);
    expect(mocks.listBindingsForAccountMock).not.toHaveBeenCalled();
  });
});

describe("handleMatrixSubagentEnded", () => {
  it("removes matching bindings and persists each affected account once", async () => {
    mocks.listBindingsForAccountMock.mockReturnValue([
      makeBinding(),
      makeBinding({ targetSessionKey: "agent:ops:subagent:other" }),
    ]);
    mocks.getManagerMock.mockReturnValue({ removeBindingsAsync: mocks.removeBindingsMock });

    await handleMatrixSubagentEnded(makeBinding());

    expect(mocks.removeBindingsMock).toHaveBeenCalledExactlyOnceWith([makeBinding()]);
  });

  it("uses the binding service for requested farewell cleanup", async () => {
    const binding = makeBinding();
    mocks.listBindingsForAccountMock.mockReturnValue([binding]);
    mocks.unbindMock.mockResolvedValue([{ ...binding, bindingId: "ops:!room:example:$thread" }]);

    await handleMatrixSubagentEnded({
      ...binding,
      reason: "subagent-complete",
      sendFarewell: true,
    });

    expect(mocks.unbindMock).toHaveBeenCalledWith({
      bindingId: "ops:!room:example:$thread",
      reason: "subagent-complete",
      scope: { channel: "matrix", accountId: "ops" },
    });
    expect(mocks.removeBindingsMock).not.toHaveBeenCalled();
  });
});
