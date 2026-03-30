import { afterEach, describe, expect, it, vi } from "vitest";
import type { MatrixClient } from "../sdk.js";
import { createDirectRoomTracker } from "./direct.js";

type MockStateEvents = Record<string, Record<string, unknown>>;

function createMockClient(params: {
	isDm?: boolean;
	members?: string[];
	stateEvents?: MockStateEvents;
	dmCacheAvailable?: boolean;
}) {
	let members = params.members ?? ["@alice:example.org", "@bot:example.org"];
	const stateEvents = params.stateEvents ?? {};
	return {
		dms: {
			update: vi.fn().mockResolvedValue(params.dmCacheAvailable !== false),
			isDm: vi.fn().mockReturnValue(params.isDm === true),
		},
		getUserId: vi.fn().mockResolvedValue("@bot:example.org"),
		getJoinedRoomMembers: vi.fn().mockImplementation(async () => members),
		getRoomStateEvent: vi
			.fn()
			.mockImplementation(
				async (roomId: string, eventType: string, stateKey = "") => {
					const key = `${roomId}|${eventType}|${stateKey}`;
					const state = stateEvents[key];
					if (state === undefined) {
						throw new Error(`State event not found: ${key}`);
					}
					return state;
				},
			),
		__setMembers(next: string[]) {
			members = next;
		},
	} as unknown as MatrixClient & {
		dms: {
			update: ReturnType<typeof vi.fn>;
			isDm: ReturnType<typeof vi.fn>;
		};
		getJoinedRoomMembers: ReturnType<typeof vi.fn>;
		getRoomStateEvent: ReturnType<typeof vi.fn>;
		__setMembers: (members: string[]) => void;
	};
}

describe("createDirectRoomTracker", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("treats m.direct rooms as DMs", async () => {
		const client = createMockClient({ isDm: true });
		const tracker = createDirectRoomTracker(client);

		await expect(
			tracker.isDirectMessage({
				roomId: "!room:example.org",
				senderId: "@alice:example.org",
			}),
		).resolves.toBe(true);

		expect(client.getJoinedRoomMembers).toHaveBeenCalledWith(
			"!room:example.org",
		);
	});

	it("does not trust stale m.direct classifications for shared rooms", async () => {
		const client = createMockClient({
			isDm: true,
			members: ["@alice:example.org", "@bot:example.org", "@extra:example.org"],
		});
		const tracker = createDirectRoomTracker(client);

		await expect(
			tracker.isDirectMessage({
				roomId: "!room:example.org",
				senderId: "@alice:example.org",
			}),
		).resolves.toBe(false);

		expect(client.getJoinedRoomMembers).toHaveBeenCalledWith(
			"!room:example.org",
		);
	});

	it("does not classify 2-member rooms as DMs when the dm cache refresh succeeds", async () => {
		const client = createMockClient({ isDm: false, dmCacheAvailable: true });
		const tracker = createDirectRoomTracker(client);

		await expect(
			tracker.isDirectMessage({
				roomId: "!room:example.org",
				senderId: "@alice:example.org",
			}),
		).resolves.toBe(false);

		expect(client.getJoinedRoomMembers).toHaveBeenCalledWith(
			"!room:example.org",
		);
	});

	it("falls back to strict 2-member membership before m.direct account data is available", async () => {
		const client = createMockClient({ isDm: false, dmCacheAvailable: false });
		const tracker = createDirectRoomTracker(client);

		await expect(
			tracker.isDirectMessage({
				roomId: "!room:example.org",
				senderId: "@alice:example.org",
			}),
		).resolves.toBe(true);

		expect(client.getJoinedRoomMembers).toHaveBeenCalledWith(
			"!room:example.org",
		);
	});

	it("keeps using the strict 2-member fallback until the dm cache seeds successfully", async () => {
		const client = createMockClient({ isDm: false, dmCacheAvailable: false });
		const tracker = createDirectRoomTracker(client);

		await expect(
			tracker.isDirectMessage({
				roomId: "!room:example.org",
				senderId: "@alice:example.org",
			}),
		).resolves.toBe(true);
		await expect(
			tracker.isDirectMessage({
				roomId: "!room:example.org",
				senderId: "@alice:example.org",
			}),
		).resolves.toBe(true);

		expect(client.dms.update).toHaveBeenCalledTimes(1);
	});

	it("does not classify rooms with extra members as DMs when falling back", async () => {
		const client = createMockClient({
			isDm: false,
			members: [
				"@alice:example.org",
				"@bot:example.org",
				"@observer:example.org",
			],
			dmCacheAvailable: false,
		});
		const tracker = createDirectRoomTracker(client);

		await expect(
			tracker.isDirectMessage({
				roomId: "!room:example.org",
				senderId: "@alice:example.org",
			}),
		).resolves.toBe(false);

		expect(client.getRoomStateEvent).not.toHaveBeenCalled();
	});

	it("treats sender is_direct member state as a DM signal", async () => {
		const client = createMockClient({
			isDm: false,
			stateEvents: {
				"!room:example.org|m.room.member|@alice:example.org": {
					is_direct: true,
				},
			},
		});
		const tracker = createDirectRoomTracker(client);

		await expect(
			tracker.isDirectMessage({
				roomId: "!room:example.org",
				senderId: "@alice:example.org",
			}),
		).resolves.toBe(true);
	});

	it("treats self is_direct member state as a DM signal", async () => {
		const client = createMockClient({
			isDm: false,
			stateEvents: {
				"!room:example.org|m.room.member|@bot:example.org": { is_direct: true },
			},
		});
		const tracker = createDirectRoomTracker(client);

		await expect(
			tracker.isDirectMessage({
				roomId: "!room:example.org",
				senderId: "@alice:example.org",
			}),
		).resolves.toBe(true);
	});

	it("does not classify 2-member rooms whose sender is not a joined member when falling back", async () => {
		const client = createMockClient({
			isDm: false,
			members: ["@mallory:example.org", "@bot:example.org"],
			dmCacheAvailable: false,
		});
		const tracker = createDirectRoomTracker(client);

		await expect(
			tracker.isDirectMessage({
				roomId: "!room:example.org",
				senderId: "@alice:example.org",
			}),
		).resolves.toBe(false);
	});

	it("does not re-enable the strict 2-member fallback after the dm cache has seeded", async () => {
		const client = createMockClient({ isDm: false, dmCacheAvailable: true });
		const tracker = createDirectRoomTracker(client);

		await expect(
			tracker.isDirectMessage({
				roomId: "!room:example.org",
				senderId: "@alice:example.org",
			}),
		).resolves.toBe(false);

		client.dms.update.mockResolvedValue(false);
		tracker.invalidateRoom("!room:example.org");

		await expect(
			tracker.isDirectMessage({
				roomId: "!room:example.org",
				senderId: "@alice:example.org",
			}),
		).resolves.toBe(false);
	});

	it("re-checks room membership after invalidation when fallback membership changes", async () => {
		const client = createMockClient({ isDm: false, dmCacheAvailable: false });
		const tracker = createDirectRoomTracker(client);

		await expect(
			tracker.isDirectMessage({
				roomId: "!room:example.org",
				senderId: "@alice:example.org",
			}),
		).resolves.toBe(true);

		client.__setMembers([
			"@alice:example.org",
			"@bot:example.org",
			"@mallory:example.org",
		]);
		tracker.invalidateRoom("!room:example.org");

		await expect(
			tracker.isDirectMessage({
				roomId: "!room:example.org",
				senderId: "@alice:example.org",
			}),
		).resolves.toBe(false);
	});

	it("bounds joined-room membership cache size", async () => {
		const client = createMockClient({ isDm: false, dmCacheAvailable: false });
		const tracker = createDirectRoomTracker(client);

		for (let i = 0; i <= 1024; i += 1) {
			await tracker.isDirectMessage({
				roomId: `!room-${i}:example.org`,
				senderId: "@alice:example.org",
			});
		}

		await tracker.isDirectMessage({
			roomId: "!room-0:example.org",
			senderId: "@alice:example.org",
		});

		expect(client.getJoinedRoomMembers).toHaveBeenCalledTimes(1026);
	});

	it("refreshes dm and membership caches after the ttl expires", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-03-12T10:00:00Z"));
		const client = createMockClient({ isDm: true });
		const tracker = createDirectRoomTracker(client);

		await tracker.isDirectMessage({
			roomId: "!room:example.org",
			senderId: "@alice:example.org",
		});
		await tracker.isDirectMessage({
			roomId: "!room:example.org",
			senderId: "@alice:example.org",
		});

		expect(client.dms.update).toHaveBeenCalledTimes(1);
		expect(client.getJoinedRoomMembers).toHaveBeenCalledTimes(1);

		vi.setSystemTime(new Date("2026-03-12T10:00:31Z"));

		await tracker.isDirectMessage({
			roomId: "!room:example.org",
			senderId: "@alice:example.org",
		});

		expect(client.dms.update).toHaveBeenCalledTimes(2);
		expect(client.getJoinedRoomMembers).toHaveBeenCalledTimes(2);
	});

	it("caches member-state direct flag lookups until the ttl expires", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-03-12T10:00:00Z"));
		const client = createMockClient({
			isDm: false,
			dmCacheAvailable: true,
			stateEvents: {
				"!room:example.org|m.room.member|@alice:example.org": {
					is_direct: true,
				},
			},
		});
		const tracker = createDirectRoomTracker(client);

		await tracker.isDirectMessage({
			roomId: "!room:example.org",
			senderId: "@alice:example.org",
		});
		await tracker.isDirectMessage({
			roomId: "!room:example.org",
			senderId: "@alice:example.org",
		});

		expect(client.getRoomStateEvent).toHaveBeenCalledTimes(1);

		vi.setSystemTime(new Date("2026-03-12T10:00:31Z"));

		await tracker.isDirectMessage({
			roomId: "!room:example.org",
			senderId: "@alice:example.org",
		});

		expect(client.getRoomStateEvent).toHaveBeenCalledTimes(2);
	});
});
