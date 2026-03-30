import { vi } from "vitest";

const runtimeMocks = vi.hoisted(() => ({
	readAllowFromStoreMock: vi.fn(),
	upsertPairingRequestMock: vi.fn(),
	recordInboundSessionMock: vi.fn(),
	resolvePluginConversationBindingApprovalMock: vi.fn(),
	buildPluginBindingResolvedTextMock: vi.fn(),
}));

export const readAllowFromStoreMock = runtimeMocks.readAllowFromStoreMock;
export const upsertPairingRequestMock = runtimeMocks.upsertPairingRequestMock;
export const recordInboundSessionMock = runtimeMocks.recordInboundSessionMock;
export const resolvePluginConversationBindingApprovalMock =
	runtimeMocks.resolvePluginConversationBindingApprovalMock;
export const buildPluginBindingResolvedTextMock =
	runtimeMocks.buildPluginBindingResolvedTextMock;

async function createConversationRuntimeMock(
	importOriginal: () => Promise<
		typeof import("openclaw/plugin-sdk/conversation-runtime")
	>,
) {
	const actual = await importOriginal();
	return {
		...actual,
		upsertChannelPairingRequest: (...args: unknown[]) =>
			upsertPairingRequestMock(...args),
		resolvePluginConversationBindingApproval: (...args: unknown[]) =>
			resolvePluginConversationBindingApprovalMock(...args),
		buildPluginBindingResolvedText: (...args: unknown[]) =>
			buildPluginBindingResolvedTextMock(...args),
		recordInboundSession: (...args: unknown[]) =>
			recordInboundSessionMock(...args),
	};
}

async function createAllowFromRuntimeMock<TModule>(
	importOriginal: () => Promise<TModule>,
): Promise<
	TModule & {
		readStoreAllowFromForDmPolicy: typeof readStoreAllowFromForDmPolicy;
	}
> {
	const actual = await importOriginal();
	return {
		...actual,
		readStoreAllowFromForDmPolicy,
	};
}

async function readStoreAllowFromForDmPolicy(params: {
	provider: string;
	accountId: string;
	dmPolicy?: string | null;
	shouldRead?: boolean | null;
}) {
	if (params.shouldRead === false || params.dmPolicy === "allowlist") {
		return [];
	}
	return await readAllowFromStoreMock(params.provider, params.accountId);
}

vi.mock("openclaw/plugin-sdk/security-runtime", (importOriginal) =>
	createAllowFromRuntimeMock(importOriginal),
);

vi.mock(
	"openclaw/plugin-sdk/conversation-runtime",
	createConversationRuntimeMock,
);
vi.mock(
	"openclaw/plugin-sdk/conversation-runtime.js",
	createConversationRuntimeMock,
);
vi.mock("../../../../src/pairing/pairing-store.js", async (importOriginal) => {
	const actual =
		await importOriginal<
			typeof import("../../../../src/pairing/pairing-store.js")
		>();
	return {
		...actual,
		upsertChannelPairingRequest: (...args: unknown[]) =>
			upsertPairingRequestMock(...args),
	};
});
vi.mock("../../../../src/security/dm-policy-shared.js", (importOriginal) =>
	createAllowFromRuntimeMock(importOriginal),
);

export function resetDiscordComponentRuntimeMocks() {
	readAllowFromStoreMock.mockClear().mockResolvedValue([]);
	upsertPairingRequestMock
		.mockClear()
		.mockResolvedValue({ code: "PAIRCODE", created: true });
	recordInboundSessionMock.mockClear().mockResolvedValue(undefined);
	resolvePluginConversationBindingApprovalMock.mockReset().mockResolvedValue({
		status: "approved",
		binding: {
			bindingId: "binding-1",
			pluginId: "openclaw-codex-app-server",
			pluginName: "OpenClaw App Server",
			pluginRoot: "/plugins/codex",
			channel: "discord",
			accountId: "default",
			conversationId: "user:123456789",
			boundAt: Date.now(),
		},
		request: {
			id: "approval-1",
			pluginId: "openclaw-codex-app-server",
			pluginName: "OpenClaw App Server",
			pluginRoot: "/plugins/codex",
			requestedAt: Date.now(),
			conversation: {
				channel: "discord",
				accountId: "default",
				conversationId: "user:123456789",
			},
		},
		decision: "allow-once",
	});
	buildPluginBindingResolvedTextMock
		.mockReset()
		.mockReturnValue("Binding approved.");
}
