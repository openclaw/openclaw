import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";

const hoisted = vi.hoisted(() => {
	const resolveAllAgentSessionStoreTargetsMock = vi.fn();
	const loadSessionStoreMock = vi.fn();
	return {
		resolveAllAgentSessionStoreTargetsMock,
		loadSessionStoreMock,
	};
});

vi.mock("../../config/sessions.js", () => ({
	loadSessionStore: (storePath: string) =>
		hoisted.loadSessionStoreMock(storePath),
	resolveAllAgentSessionStoreTargets: (cfg: OpenClawConfig, opts: unknown) =>
		hoisted.resolveAllAgentSessionStoreTargetsMock(cfg, opts),
	resolveStorePath: vi.fn(() => "/tmp/sessions.json"),
	updateSessionStore: vi.fn(),
}));
let listAcpSessionEntries: typeof import("./session-meta.js").listAcpSessionEntries;

describe("listAcpSessionEntries", () => {
	beforeEach(async () => {
		vi.resetModules();
		vi.clearAllMocks();
		({ listAcpSessionEntries } = await import("./session-meta.js"));
	});

	it("reads ACP sessions from resolved configured store targets", async () => {
		const cfg = {
			session: {
				store: "/custom/sessions/{agentId}.json",
			},
		} as OpenClawConfig;
		hoisted.resolveAllAgentSessionStoreTargetsMock.mockResolvedValue([
			{
				agentId: "ops",
				storePath: "/custom/sessions/ops.json",
			},
		]);
		hoisted.loadSessionStoreMock.mockReturnValue({
			"agent:ops:acp:s1": {
				updatedAt: 123,
				acp: {
					backend: "acpx",
					agent: "ops",
					mode: "persistent",
					state: "idle",
				},
			},
		});

		const entries = await listAcpSessionEntries({ cfg });

		expect(hoisted.resolveAllAgentSessionStoreTargetsMock).toHaveBeenCalledWith(
			cfg,
			undefined,
		);
		expect(hoisted.loadSessionStoreMock).toHaveBeenCalledWith(
			"/custom/sessions/ops.json",
		);
		expect(entries).toEqual([
			expect.objectContaining({
				cfg,
				storePath: "/custom/sessions/ops.json",
				sessionKey: "agent:ops:acp:s1",
				storeSessionKey: "agent:ops:acp:s1",
			}),
		]);
	});
});
