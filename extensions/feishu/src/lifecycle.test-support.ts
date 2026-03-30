import { vi } from "vitest";

type BoundConversation = {
	bindingId: string;
	targetSessionKey: string;
};

const feishuLifecycleTestMocks = vi.hoisted(() => ({
	createEventDispatcherMock: vi.fn(),
	monitorWebSocketMock: vi.fn(async () => {}),
	monitorWebhookMock: vi.fn(async () => {}),
	createFeishuThreadBindingManagerMock: vi.fn(() => ({ stop: vi.fn() })),
	createFeishuReplyDispatcherMock: vi.fn(),
	resolveBoundConversationMock: vi.fn<() => BoundConversation | null>(
		() => null,
	),
	touchBindingMock: vi.fn(),
	resolveAgentRouteMock: vi.fn(),
	resolveConfiguredBindingRouteMock: vi.fn(),
	ensureConfiguredBindingRouteReadyMock: vi.fn(),
	dispatchReplyFromConfigMock: vi.fn(),
	withReplyDispatcherMock: vi.fn(),
	finalizeInboundContextMock: vi.fn((ctx) => ctx),
	getMessageFeishuMock: vi.fn(async () => null),
	listFeishuThreadMessagesMock: vi.fn(async () => []),
	sendMessageFeishuMock: vi.fn(async () => ({
		messageId: "om_sent",
		chatId: "chat_default",
	})),
	sendCardFeishuMock: vi.fn(async () => ({
		messageId: "om_card",
		chatId: "chat_default",
	})),
}));

export function getFeishuLifecycleTestMocks() {
	return feishuLifecycleTestMocks;
}

const {
	createEventDispatcherMock,
	monitorWebSocketMock,
	monitorWebhookMock,
	createFeishuThreadBindingManagerMock,
	createFeishuReplyDispatcherMock,
	resolveBoundConversationMock,
	touchBindingMock,
	resolveAgentRouteMock,
	resolveConfiguredBindingRouteMock,
	ensureConfiguredBindingRouteReadyMock,
	dispatchReplyFromConfigMock,
	withReplyDispatcherMock,
	finalizeInboundContextMock,
	getMessageFeishuMock,
	listFeishuThreadMessagesMock,
	sendMessageFeishuMock,
	sendCardFeishuMock,
} = feishuLifecycleTestMocks;

vi.mock("./client.js", async () => {
	const actual =
		await vi.importActual<typeof import("./client.js")>("./client.js");
	return {
		...actual,
		createEventDispatcher: createEventDispatcherMock,
	};
});

vi.mock("./monitor.transport.js", () => ({
	monitorWebSocket: monitorWebSocketMock,
	monitorWebhook: monitorWebhookMock,
}));

vi.mock("./thread-bindings.js", () => ({
	createFeishuThreadBindingManager: createFeishuThreadBindingManagerMock,
}));

vi.mock("./reply-dispatcher.js", () => ({
	createFeishuReplyDispatcher: createFeishuReplyDispatcherMock,
}));

vi.mock("./send.js", () => ({
	sendCardFeishu: sendCardFeishuMock,
	getMessageFeishu: getMessageFeishuMock,
	listFeishuThreadMessages: listFeishuThreadMessagesMock,
	sendMessageFeishu: sendMessageFeishuMock,
}));

vi.mock("openclaw/plugin-sdk/conversation-runtime", async (importOriginal) => {
	const actual =
		await importOriginal<
			typeof import("openclaw/plugin-sdk/conversation-runtime")
		>();
	return {
		...actual,
		resolveConfiguredBindingRoute: (
			params: Parameters<typeof actual.resolveConfiguredBindingRoute>[0],
		) =>
			resolveConfiguredBindingRouteMock.getMockImplementation()
				? resolveConfiguredBindingRouteMock(params)
				: actual.resolveConfiguredBindingRoute(params),
		ensureConfiguredBindingRouteReady: (
			params: Parameters<typeof actual.ensureConfiguredBindingRouteReady>[0],
		) =>
			ensureConfiguredBindingRouteReadyMock.getMockImplementation()
				? ensureConfiguredBindingRouteReadyMock(params)
				: actual.ensureConfiguredBindingRouteReady(params),
		getSessionBindingService: () => ({
			resolveByConversation: resolveBoundConversationMock,
			touch: touchBindingMock,
		}),
	};
});

vi.mock("../../../src/infra/outbound/session-binding-service.js", () => ({
	getSessionBindingService: () => ({
		resolveByConversation: resolveBoundConversationMock,
		touch: touchBindingMock,
	}),
}));
