import type { PluginRuntime } from "openclaw/plugin-sdk/channel-core";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import type { createChannelInteractiveDispatcher } from "openclaw/plugin-sdk/plugin-runtime";
import { beforeAll, beforeEach, vi } from "vitest";
import type { SlackInteractiveHandlerContext } from "../../interactive-dispatch.js";
import { createContext } from "./interactions.test-support.js";

const enqueueSessionEventMock = vi.hoisted(() =>
  vi.fn<PluginRuntime["system"]["enqueueSessionEvent"]>(),
);
const captureSessionEventTargetMock = vi.hoisted(() =>
  vi.fn<PluginRuntime["system"]["captureSessionEventTarget"]>(),
);
const ack = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
const respond = vi
  .fn<
    NonNullable<
      Parameters<ReturnType<ReturnType<typeof createContext>["getHandler"]>>[0]["respond"]
    >
  >()
  .mockResolvedValue(undefined);
const readSlackMessagesMock = vi.hoisted(() =>
  vi.fn<typeof import("../../actions.js").readSlackMessages>(),
);
export type DispatchPluginInteractiveHandlerResult = {
  matched: boolean;
  handled: boolean;
  duplicate: boolean;
  result?: unknown;
};
type PluginDispatchParams = Parameters<
  ReturnType<
    typeof createChannelInteractiveDispatcher<
      "slack",
      "interaction",
      SlackInteractiveHandlerContext
    >
  >
>[0];
const dispatchPluginInteractiveHandlerMock = vi.hoisted(() =>
  vi.fn<(arg: PluginDispatchParams) => Promise<DispatchPluginInteractiveHandlerResult>>(),
);
const resolvePluginConversationBindingApprovalMock = vi.hoisted(() =>
  vi.fn<
    typeof import("openclaw/plugin-sdk/conversation-runtime").resolvePluginConversationBindingApproval
  >(),
);
const buildPluginBindingResolvedTextMock = vi.hoisted(() =>
  vi.fn<typeof import("openclaw/plugin-sdk/conversation-runtime").buildPluginBindingResolvedText>(
    () => "Binding updated.",
  ),
);
type ApprovalResolveMockResult = {
  applied: boolean;
  approval: { presentation: { kind: "exec" | "plugin" | "system-agent" } } & (
    | { status: "allowed"; decision: "allow-once" | "allow-always" }
    | { status: "denied"; decision: "deny" }
    | { status: "expired" | "cancelled" }
  );
};
const resolveApprovalOverGatewayMock = vi.hoisted(() =>
  vi.fn<(arg: unknown) => Promise<ApprovalResolveMockResult>>(async (_arg: unknown) => ({
    applied: true,
    approval: { status: "allowed", decision: "allow-once", presentation: { kind: "exec" } },
  })),
);
const resolveQuestionOverGatewayMock = vi.hoisted(() =>
  vi.fn(async (_arg: unknown) => ({
    status: "answered" as const,
    questionId: "target",
    optionValue: "Production",
  })),
);

export let registerSlackInteractionEvents: typeof import("./interactions.js").registerSlackInteractionEvents;

vi.mock("../../test-runtime.test-support.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../test-runtime.test-support.js")>();
  return {
    ...actual,
    installSlackTestRuntime: () =>
      actual.installSlackTestRuntime({
        system: {
          captureSessionEventTarget: captureSessionEventTargetMock,
          enqueueSessionEvent: enqueueSessionEventMock,
        },
      }),
  };
});

vi.mock("openclaw/plugin-sdk/approval-gateway-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/approval-gateway-runtime")>()),
  resolveApprovalOverGateway: (arg: unknown) => resolveApprovalOverGatewayMock(arg),
}));

vi.mock("../../actions.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../actions.js")>()),
  readSlackMessages: readSlackMessagesMock,
}));

vi.mock("openclaw/plugin-sdk/question-gateway-runtime", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("openclaw/plugin-sdk/question-gateway-runtime")>();
  return {
    ...actual,
    questionGatewayRuntime: {
      ...actual.questionGatewayRuntime,
      resolveOption: (arg: unknown) => resolveQuestionOverGatewayMock(arg),
    },
  };
});

vi.mock("openclaw/plugin-sdk/plugin-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/plugin-runtime")>();
  return {
    ...actual,
    createChannelInteractiveDispatcher: () => dispatchPluginInteractiveHandlerMock,
  };
});

vi.mock("openclaw/plugin-sdk/conversation-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/conversation-runtime")>();

  return {
    ...actual,
    buildPluginBindingResolvedText: buildPluginBindingResolvedTextMock,
    resolvePluginConversationBindingApproval: resolvePluginConversationBindingApprovalMock,
  };
});

beforeAll(async () => {
  ({ registerSlackInteractionEvents } = await import("./interactions.js"));
});

beforeEach(() => {
  ack.mockClear();
  respond.mockClear();
  readSlackMessagesMock.mockReset();
  readSlackMessagesMock.mockResolvedValue({ messages: [], hasMore: false });
  enqueueSessionEventMock.mockReset();
  enqueueSessionEventMock.mockReturnValue({
    id: "slack-interaction",
    cancel: () => false,
    accepted: Promise.resolve({ ok: true }),
    settled: Promise.resolve({ status: "completed", executionStarted: true, delivered: true }),
  });
  captureSessionEventTargetMock.mockReset();
  captureSessionEventTargetMock.mockImplementation(
    createPluginRuntimeMock().system.captureSessionEventTarget,
  );
  dispatchPluginInteractiveHandlerMock.mockClear();
  resolvePluginConversationBindingApprovalMock.mockClear();
  resolvePluginConversationBindingApprovalMock.mockResolvedValue({ status: "expired" });
  buildPluginBindingResolvedTextMock.mockClear();
  buildPluginBindingResolvedTextMock.mockReturnValue("Binding updated.");
  resolveApprovalOverGatewayMock.mockClear();
  resolveApprovalOverGatewayMock.mockResolvedValue({
    applied: true,
    approval: { status: "allowed", decision: "allow-once", presentation: { kind: "exec" } },
  });
  resolveQuestionOverGatewayMock.mockClear();
  resolveQuestionOverGatewayMock.mockResolvedValue({
    status: "answered",
    questionId: "target",
    optionValue: "Production",
  });
  dispatchPluginInteractiveHandlerMock.mockResolvedValue({
    matched: false,
    handled: false,
    duplicate: false,
  });
});

export function setupInteractions(options?: Parameters<typeof createContext>[0]) {
  const context = createContext(options);
  // SAFETY: createContext supplies the listener registration, policy, routing, and runtime fields exercised by these handlers; unrelated monitor services stay absent.
  registerSlackInteractionEvents({ ctx: context.ctx as never });
  return context;
}

export function getSlackInteractionMocks() {
  return {
    enqueueSessionEventMock,
    captureSessionEventTargetMock,
    ack,
    respond,
    readSlackMessagesMock,
    dispatchPluginInteractiveHandlerMock,
    resolvePluginConversationBindingApprovalMock,
    buildPluginBindingResolvedTextMock,
    resolveApprovalOverGatewayMock,
    resolveQuestionOverGatewayMock,
  };
}
