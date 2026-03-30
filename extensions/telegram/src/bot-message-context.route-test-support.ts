import { vi } from "vitest";

const hoisted = vi.hoisted(() => ({
	recordInboundSessionMock: vi.fn().mockResolvedValue(undefined),
}));

export const recordInboundSessionMock = hoisted.recordInboundSessionMock;

vi.mock("openclaw/plugin-sdk/conversation-runtime", async (importOriginal) => {
	const actual =
		await importOriginal<
			typeof import("openclaw/plugin-sdk/conversation-runtime")
		>();
	return {
		...actual,
		recordInboundSession: (...args: unknown[]) =>
			recordInboundSessionMock(...args),
	};
});

export async function loadTelegramMessageContextRouteHarness() {
	vi.resetModules();
	const [
		{ clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot },
		{ buildTelegramMessageContextForTest },
	] = await Promise.all([
		import("../../../src/config/config.js"),
		import("./bot-message-context.test-harness.js"),
	]);
	return {
		clearRuntimeConfigSnapshot,
		setRuntimeConfigSnapshot,
		buildTelegramMessageContextForTest,
	};
}

export function getRecordedUpdateLastRoute(callIndex = -1): unknown {
	const callArgs =
		callIndex === -1
			? (recordInboundSessionMock.mock.calls.at(-1)?.[0] as
					| { updateLastRoute?: unknown }
					| undefined)
			: (recordInboundSessionMock.mock.calls[callIndex]?.[0] as
					| { updateLastRoute?: unknown }
					| undefined);
	return callArgs?.updateLastRoute;
}
