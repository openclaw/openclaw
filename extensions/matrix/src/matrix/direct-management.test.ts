import { describe, expect, it, vi } from "vitest";
import {
	inspectMatrixDirectRooms,
	repairMatrixDirectRooms,
} from "./direct-management.js";
import type { MatrixClient } from "./sdk.js";
import { EventType } from "./send/types.js";

function createClient(overrides: Partial<MatrixClient> = {}): MatrixClient {
	return {
		getUserId: vi.fn(async () => "@bot:example.org"),
		getAccountData: vi.fn(async () => undefined),
		getJoinedRooms: vi.fn(async () => [] as string[]),
		getJoinedRoomMembers: vi.fn(async () => [] as string[]),
		getRoomStateEvent: vi.fn(async () => ({})),
		setAccountData: vi.fn(async () => undefined),
		createDirectRoom: vi.fn(async () => "!created:example.org"),
		...overrides,
	} as unknown as MatrixClient;
}

describe("inspectMatrixDirectRooms", () => {
	it("prefers strict mapped rooms over discovered rooms", async () => {
		const client = createClient({
			getAccountData: vi.fn(async () => ({
				"@alice:example.org": ["!dm:example.org", "!shared:example.org"],
			})),
			getJoinedRooms: vi.fn(async () => [
				"!dm:example.org",
				"!shared:example.org",
			]),
			getJoinedRoomMembers: vi.fn(async (roomId: string) =>
				roomId === "!dm:example.org"
					? ["@bot:example.org", "@alice:example.org"]
					: ["@bot:example.org", "@alice:example.org", "@mallory:example.org"],
			),
		});

		const result = await inspectMatrixDirectRooms({
			client,
			remoteUserId: "@alice:example.org",
		});

		expect(result.activeRoomId).toBe("!dm:example.org");
		expect(result.mappedRooms).toEqual([
			expect.objectContaining({ roomId: "!dm:example.org", strict: true }),
			expect.objectContaining({ roomId: "!shared:example.org", strict: false }),
		]);
	});

	it("falls back to discovered strict joined rooms when m.direct is stale", async () => {
		const client = createClient({
			getAccountData: vi.fn(async () => ({
				"@alice:example.org": ["!stale:example.org"],
			})),
			getJoinedRooms: vi.fn(async () => [
				"!stale:example.org",
				"!fresh:example.org",
			]),
			getJoinedRoomMembers: vi.fn(async (roomId: string) =>
				roomId === "!fresh:example.org"
					? ["@bot:example.org", "@alice:example.org"]
					: ["@bot:example.org", "@alice:example.org", "@mallory:example.org"],
			),
		});

		const result = await inspectMatrixDirectRooms({
			client,
			remoteUserId: "@alice:example.org",
		});

		expect(result.activeRoomId).toBe("!fresh:example.org");
		expect(result.discoveredStrictRoomIds).toEqual(["!fresh:example.org"]);
	});

	it("prefers discovered rooms marked direct in member state over plain strict rooms", async () => {
		const client = createClient({
			getJoinedRooms: vi.fn(async () => [
				"!fallback:example.org",
				"!explicit:example.org",
			]),
			getJoinedRoomMembers: vi.fn(async () => [
				"@bot:example.org",
				"@alice:example.org",
			]),
			getRoomStateEvent: vi.fn(
				async (roomId: string, _eventType: string, userId: string) => ({
					is_direct:
						roomId === "!explicit:example.org" &&
						userId === "@alice:example.org",
				}),
			),
		});

		const result = await inspectMatrixDirectRooms({
			client,
			remoteUserId: "@alice:example.org",
		});

		expect(result.activeRoomId).toBe("!explicit:example.org");
		expect(result.discoveredStrictRoomIds).toEqual([
			"!fallback:example.org",
			"!explicit:example.org",
		]);
	});
});

describe("repairMatrixDirectRooms", () => {
	it("repoints m.direct to an existing strict joined room", async () => {
		const setAccountData = vi.fn(async () => undefined);
		const client = createClient({
			getAccountData: vi.fn(async () => ({
				"@alice:example.org": ["!stale:example.org"],
			})),
			getJoinedRooms: vi.fn(async () => [
				"!stale:example.org",
				"!fresh:example.org",
			]),
			getJoinedRoomMembers: vi.fn(async (roomId: string) =>
				roomId === "!fresh:example.org"
					? ["@bot:example.org", "@alice:example.org"]
					: ["@bot:example.org", "@alice:example.org", "@mallory:example.org"],
			),
			setAccountData,
		});

		const result = await repairMatrixDirectRooms({
			client,
			remoteUserId: "@alice:example.org",
			encrypted: true,
		});

		expect(result.activeRoomId).toBe("!fresh:example.org");
		expect(result.createdRoomId).toBeNull();
		expect(setAccountData).toHaveBeenCalledWith(
			EventType.Direct,
			expect.objectContaining({
				"@alice:example.org": ["!fresh:example.org", "!stale:example.org"],
			}),
		);
	});

	it("creates a fresh direct room when no healthy DM exists", async () => {
		const createDirectRoom = vi.fn(async () => "!created:example.org");
		const setAccountData = vi.fn(async () => undefined);
		const client = createClient({
			getJoinedRooms: vi.fn(async () => ["!shared:example.org"]),
			getJoinedRoomMembers: vi.fn(async () => [
				"@bot:example.org",
				"@alice:example.org",
				"@mallory:example.org",
			]),
			createDirectRoom,
			setAccountData,
		});

		const result = await repairMatrixDirectRooms({
			client,
			remoteUserId: "@alice:example.org",
			encrypted: true,
		});

		expect(createDirectRoom).toHaveBeenCalledWith("@alice:example.org", {
			encrypted: true,
		});
		expect(result.createdRoomId).toBe("!created:example.org");
		expect(setAccountData).toHaveBeenCalledWith(
			EventType.Direct,
			expect.objectContaining({
				"@alice:example.org": ["!created:example.org"],
			}),
		);
	});

	it("rejects unqualified Matrix user ids", async () => {
		const client = createClient();

		await expect(
			repairMatrixDirectRooms({
				client,
				remoteUserId: "alice",
			}),
		).rejects.toThrow('Matrix user IDs must be fully qualified (got "alice")');
	});
});
