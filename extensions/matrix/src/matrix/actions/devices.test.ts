import { beforeEach, describe, expect, it, vi } from "vitest";

const withStartedActionClientMock = vi.fn();

vi.mock("./client.js", () => ({
	withStartedActionClient: (...args: unknown[]) =>
		withStartedActionClientMock(...args),
}));

const { listMatrixOwnDevices, pruneMatrixStaleGatewayDevices } = await import(
	"./devices.js"
);

describe("matrix device actions", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("lists own devices on a started client", async () => {
		withStartedActionClientMock.mockImplementation(async (_opts, run) => {
			return await run({
				listOwnDevices: vi.fn(async () => [
					{
						deviceId: "A7hWrQ70ea",
						displayName: "OpenClaw Gateway",
						lastSeenIp: null,
						lastSeenTs: null,
						current: true,
					},
				]),
			});
		});

		const result = await listMatrixOwnDevices({ accountId: "poe" });

		expect(withStartedActionClientMock).toHaveBeenCalledWith(
			{ accountId: "poe" },
			expect.any(Function),
		);
		expect(result).toEqual([
			expect.objectContaining({
				deviceId: "A7hWrQ70ea",
				current: true,
			}),
		]);
	});

	it("prunes stale OpenClaw-managed devices but preserves the current device", async () => {
		const deleteOwnDevices = vi.fn(async () => ({
			currentDeviceId: "du314Zpw3A",
			deletedDeviceIds: ["BritdXC6iL", "G6NJU9cTgs", "My3T0hkTE0"],
			remainingDevices: [
				{
					deviceId: "du314Zpw3A",
					displayName: "OpenClaw Gateway",
					lastSeenIp: null,
					lastSeenTs: null,
					current: true,
				},
			],
		}));
		withStartedActionClientMock.mockImplementation(async (_opts, run) => {
			return await run({
				listOwnDevices: vi.fn(async () => [
					{
						deviceId: "du314Zpw3A",
						displayName: "OpenClaw Gateway",
						lastSeenIp: null,
						lastSeenTs: null,
						current: true,
					},
					{
						deviceId: "BritdXC6iL",
						displayName: "OpenClaw Gateway",
						lastSeenIp: null,
						lastSeenTs: null,
						current: false,
					},
					{
						deviceId: "G6NJU9cTgs",
						displayName: "OpenClaw Debug",
						lastSeenIp: null,
						lastSeenTs: null,
						current: false,
					},
					{
						deviceId: "My3T0hkTE0",
						displayName: "OpenClaw Gateway",
						lastSeenIp: null,
						lastSeenTs: null,
						current: false,
					},
					{
						deviceId: "phone123",
						displayName: "Element iPhone",
						lastSeenIp: null,
						lastSeenTs: null,
						current: false,
					},
				]),
				deleteOwnDevices,
			});
		});

		const result = await pruneMatrixStaleGatewayDevices({ accountId: "poe" });

		expect(deleteOwnDevices).toHaveBeenCalledWith([
			"BritdXC6iL",
			"G6NJU9cTgs",
			"My3T0hkTE0",
		]);
		expect(result.staleGatewayDeviceIds).toEqual([
			"BritdXC6iL",
			"G6NJU9cTgs",
			"My3T0hkTE0",
		]);
		expect(result.deletedDeviceIds).toEqual([
			"BritdXC6iL",
			"G6NJU9cTgs",
			"My3T0hkTE0",
		]);
		expect(result.remainingDevices).toEqual([
			expect.objectContaining({
				deviceId: "du314Zpw3A",
				current: true,
			}),
		]);
	});
});
