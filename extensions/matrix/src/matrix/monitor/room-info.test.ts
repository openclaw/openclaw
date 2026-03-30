import { describe, expect, it, vi } from "vitest";
import type { MatrixClient } from "../sdk.js";
import { createMatrixRoomInfoResolver } from "./room-info.js";

function createClientStub() {
	return {
		getRoomStateEvent: vi.fn(
			async (
				roomId: string,
				eventType: string,
				stateKey: string,
			): Promise<Record<string, unknown>> => {
				if (eventType === "m.room.name") {
					return { name: `Room ${roomId}` };
				}
				if (eventType === "m.room.canonical_alias") {
					return {
						alias: `#alias-${roomId}:example.org`,
						alt_aliases: [`#alt-${roomId}:example.org`],
					};
				}
				if (eventType === "m.room.member") {
					return { displayname: `Display ${roomId}:${stateKey}` };
				}
				return {};
			},
		),
	} as unknown as MatrixClient & {
		getRoomStateEvent: ReturnType<typeof vi.fn>;
	};
}

describe("createMatrixRoomInfoResolver", () => {
	it("caches room names and member display names, and loads aliases only on demand", async () => {
		const client = createClientStub();
		const resolver = createMatrixRoomInfoResolver(client);

		await resolver.getRoomInfo("!room:example.org");
		await resolver.getRoomInfo("!room:example.org");
		await resolver.getRoomInfo("!room:example.org", { includeAliases: true });
		await resolver.getRoomInfo("!room:example.org", { includeAliases: true });
		await resolver.getMemberDisplayName(
			"!room:example.org",
			"@alice:example.org",
		);
		await resolver.getMemberDisplayName(
			"!room:example.org",
			"@alice:example.org",
		);

		expect(client.getRoomStateEvent).toHaveBeenCalledTimes(3);
	});

	it("caches fallback user IDs when member display names are missing", async () => {
		const client = {
			getRoomStateEvent: vi.fn(
				async (
					_roomId: string,
					eventType: string,
				): Promise<Record<string, unknown>> => {
					if (eventType === "m.room.member") {
						return {};
					}
					return {};
				},
			),
		} as unknown as MatrixClient & {
			getRoomStateEvent: ReturnType<typeof vi.fn>;
		};
		const resolver = createMatrixRoomInfoResolver(client);

		await expect(
			resolver.getMemberDisplayName("!room:example.org", "@alice:example.org"),
		).resolves.toBe("@alice:example.org");
		await expect(
			resolver.getMemberDisplayName("!room:example.org", "@alice:example.org"),
		).resolves.toBe("@alice:example.org");

		expect(client.getRoomStateEvent).toHaveBeenCalledTimes(1);
	});

	it("caches fallback user IDs when member display-name lookups fail", async () => {
		const client = {
			getRoomStateEvent: vi.fn(async (): Promise<Record<string, unknown>> => {
				throw new Error("member lookup failed");
			}),
		} as unknown as MatrixClient & {
			getRoomStateEvent: ReturnType<typeof vi.fn>;
		};
		const resolver = createMatrixRoomInfoResolver(client);

		await expect(
			resolver.getMemberDisplayName("!room:example.org", "@alice:example.org"),
		).resolves.toBe("@alice:example.org");
		await expect(
			resolver.getMemberDisplayName("!room:example.org", "@alice:example.org"),
		).resolves.toBe("@alice:example.org");

		expect(client.getRoomStateEvent).toHaveBeenCalledTimes(1);
	});

	it("bounds cached room and member entries", async () => {
		const client = createClientStub();
		const resolver = createMatrixRoomInfoResolver(client);

		for (let i = 0; i <= 1024; i += 1) {
			await resolver.getRoomInfo(`!room-${i}:example.org`);
		}
		await resolver.getRoomInfo("!room-0:example.org");

		for (let i = 0; i <= 4096; i += 1) {
			await resolver.getMemberDisplayName(
				"!room:example.org",
				`@user-${i}:example.org`,
			);
		}
		await resolver.getMemberDisplayName(
			"!room:example.org",
			"@user-0:example.org",
		);

		expect(client.getRoomStateEvent).toHaveBeenCalledTimes(5124);
	});
});
