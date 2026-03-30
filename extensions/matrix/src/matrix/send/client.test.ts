import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createMockMatrixClient,
	expectExplicitMatrixClientConfig,
	expectOneOffSharedMatrixClient,
	matrixClientResolverMocks,
	primeMatrixClientResolverMocks,
} from "../client-resolver.test-helpers.js";

const {
	getMatrixRuntimeMock,
	getActiveMatrixClientMock,
	acquireSharedMatrixClientMock,
	releaseSharedClientInstanceMock,
	isBunRuntimeMock,
	resolveMatrixAuthContextMock,
} = matrixClientResolverMocks;

vi.mock("../active-client.js", () => ({
	getActiveMatrixClient: (...args: unknown[]) =>
		getActiveMatrixClientMock(...args),
}));

vi.mock("../client.js", () => ({
	acquireSharedMatrixClient: (...args: unknown[]) =>
		acquireSharedMatrixClientMock(...args),
	isBunRuntime: () => isBunRuntimeMock(),
	resolveMatrixAuthContext: resolveMatrixAuthContextMock,
}));

vi.mock("../client/shared.js", () => ({
	releaseSharedClientInstance: (...args: unknown[]) =>
		releaseSharedClientInstanceMock(...args),
}));

vi.mock("../../runtime.js", () => ({
	getMatrixRuntime: () => getMatrixRuntimeMock(),
}));

let withResolvedMatrixClient: typeof import("./client.js").withResolvedMatrixClient;

describe("withResolvedMatrixClient", () => {
	beforeEach(async () => {
		vi.resetModules();
		({ withResolvedMatrixClient } = await import("./client.js"));
		primeMatrixClientResolverMocks({
			resolved: {},
		});
	});

	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("stops one-off shared clients when no active monitor client is registered", async () => {
		vi.stubEnv("OPENCLAW_GATEWAY_PORT", "18799");

		const result = await withResolvedMatrixClient(
			{ accountId: "default" },
			async () => "ok",
		);

		await expectOneOffSharedMatrixClient();
		expect(result).toBe("ok");
	});

	it("reuses active monitor client when available", async () => {
		const activeClient = createMockMatrixClient();
		getActiveMatrixClientMock.mockReturnValue(activeClient);

		const result = await withResolvedMatrixClient(
			{ accountId: "default" },
			async (client) => {
				expect(client).toBe(activeClient);
				return "ok";
			},
		);

		expect(result).toBe("ok");
		expect(acquireSharedMatrixClientMock).not.toHaveBeenCalled();
		expect(activeClient.stop).not.toHaveBeenCalled();
	});

	it("uses the effective account id when auth resolution is implicit", async () => {
		resolveMatrixAuthContextMock.mockReturnValue({
			cfg: {},
			env: process.env,
			accountId: "ops",
			resolved: {},
		});
		await withResolvedMatrixClient({}, async () => {});

		await expectOneOffSharedMatrixClient({
			accountId: "ops",
		});
	});

	it("uses explicit cfg instead of loading runtime config", async () => {
		const explicitCfg = {
			channels: {
				matrix: {
					defaultAccount: "ops",
				},
			},
		};

		await withResolvedMatrixClient(
			{ cfg: explicitCfg, accountId: "ops" },
			async () => {},
		);

		expectExplicitMatrixClientConfig({
			cfg: explicitCfg,
			accountId: "ops",
		});
	});

	it("stops shared matrix clients when wrapped sends fail", async () => {
		const sharedClient = createMockMatrixClient();
		acquireSharedMatrixClientMock.mockResolvedValue(sharedClient);

		await expect(
			withResolvedMatrixClient({ accountId: "default" }, async () => {
				throw new Error("boom");
			}),
		).rejects.toThrow("boom");

		expect(releaseSharedClientInstanceMock).toHaveBeenCalledWith(
			sharedClient,
			"stop",
		);
	});
});
