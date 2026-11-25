import { describe, expect, it, vi } from "vitest";
import type { MatrixClient } from "../sdk.js";
import { listMatrixEmojis, listMatrixReactions, removeMatrixReactions } from "./reactions.js";

const ROOM = "!room:example.org";
const REACTIONS_PATH =
  "/_matrix/client/v1/rooms/!room%3Aexample.org/relations/%24msg/m.annotation/m.reaction";
type ReactionPage = { chunk: ReturnType<typeof reaction>[]; next_batch?: string };

function emotePack(images: unknown, state_key = "", pack?: { usage: string[] }) {
  return { type: "im.ponies.room_emotes", state_key, content: { images, pack } };
}

function reaction(event_id: string, sender: string, key?: string) {
  return {
    event_id,
    sender,
    content: key ? { "m.relates_to": { rel_type: "m.annotation", event_id: "$target", key } } : {},
  };
}

function createReactionsClient(
  chunk: ReturnType<typeof reaction>[] = [],
  userId: string | null = null,
) {
  const doRequest = vi.fn(async (): Promise<ReactionPage> => ({ chunk }));
  const redactEvent = vi.fn(async () => undefined);

  return {
    client: {
      doRequest,
      getUserId: vi.fn(async () => userId),
      redactEvent,
      stop: vi.fn(),
    } as unknown as MatrixClient,
    doRequest,
    redactEvent,
  };
}

describe("matrix reaction actions", () => {
  it("lists sorted room and personal MSC2545 emoticons while rejecting malformed and sticker-only images", async () => {
    const doRequest = vi.fn(async () => [
      emotePack({
        zebra: { url: "mxc://example.org/zebra" },
        sticker: { url: "mxc://example.org/sticker", usage: ["sticker"] },
        wrongUrl: { url: "https://example.org/wrong" },
        incompleteMxc: { url: "mxc://example.org" },
        wrongUsage: { url: "mxc://example.org/wrong-usage", usage: "emoticon" },
        malformed: null,
      }),
      emotePack(
        {
          hidden: { url: "mxc://example.org/hidden" },
          alpha: { url: "mxc://example.org/alpha", usage: ["emoticon", "sticker"] },
        },
        "extra-pack",
        { usage: ["sticker"] },
      ),
      emotePack([], "broken"),
      { type: "m.room.name", state_key: "", content: { images: { ignored: {} } } },
    ]);
    const getAccountData = vi.fn(async () => ({
      images: { middle: { url: "mxc://example.org/middle", usage: ["emoticon"] } },
    }));
    const client = { doRequest, getAccountData, stop: vi.fn() } as unknown as MatrixClient;

    await expect(listMatrixEmojis(ROOM, { client })).resolves.toStrictEqual([
      { name: "alpha", identifier: "alpha", url: "mxc://example.org/alpha" },
      { name: "middle", identifier: "middle", url: "mxc://example.org/middle" },
      { name: "zebra", identifier: "zebra", url: "mxc://example.org/zebra" },
    ]);
    expect(doRequest).toHaveBeenCalledWith(
      "GET",
      "/_matrix/client/v3/rooms/!room%3Aexample.org/state",
    );
    expect(getAccountData).toHaveBeenCalledWith("im.ponies.user_emotes");
  });

  it("fails visibly when the room-state response is malformed", async () => {
    const client = {
      doRequest: vi.fn(async () => ({ state: [] })),
      getAccountData: vi.fn(async () => undefined),
      stop: vi.fn(),
    } as unknown as MatrixClient;

    await expect(listMatrixEmojis(ROOM, { client })).rejects.toThrow(
      "Matrix room state response is invalid.",
    );
  });

  it("aggregates reactions by key and unique sender", async () => {
    const { client, doRequest } = createReactionsClient(
      [
        reaction("$1", "@alice:example.org", "👍"),
        reaction("$2", "@bob:example.org", "👍"),
        reaction("$3", "@alice:example.org", "👎"),
        reaction("$4", "@bot:example.org"),
      ],
      "@bot:example.org",
    );

    const result = await listMatrixReactions(ROOM, "$msg", { client, limit: 2.9 });

    expect(doRequest).toHaveBeenCalledWith("GET", REACTIONS_PATH, { dir: "b", limit: 2 });
    expect(result).toStrictEqual([
      { key: "👍", count: 2, users: ["@alice:example.org", "@bob:example.org"] },
      { key: "👎", count: 1, users: ["@alice:example.org"] },
    ]);
  });

  it("removes only matching current-user reactions, including later pages", async () => {
    const { client, doRequest, redactEvent } = createReactionsClient(
      [
        reaction("$1", "@me:example.org", "👍"),
        reaction("$2", "@me:example.org", "👎"),
        reaction("$3", "@other:example.org", "👍"),
      ],
      "@me:example.org",
    );
    doRequest.mockResolvedValueOnce({ chunk: [], next_batch: "older-reactions" });

    await expect(removeMatrixReactions(ROOM, "$msg", { client, emoji: "👍" })).resolves.toEqual({
      removed: 1,
    });
    expect(redactEvent).toHaveBeenCalledTimes(1);
    expect(redactEvent).toHaveBeenCalledWith(ROOM, "$1");
    expect(doRequest).toHaveBeenNthCalledWith(2, "GET", REACTIONS_PATH, {
      dir: "b",
      limit: 200,
      from: "older-reactions",
    });
  });

  it("continues listing across empty relation pages", async () => {
    const { client, doRequest } = createReactionsClient();
    doRequest
      .mockResolvedValueOnce({ chunk: [], next_batch: "older-reactions" })
      .mockResolvedValueOnce({ chunk: [reaction("$mine", "@me:example.org", "👍")] });

    await expect(listMatrixReactions(ROOM, "$msg", { client })).resolves.toEqual([
      { key: "👍", count: 1, users: ["@me:example.org"] },
    ]);
    expect(doRequest).toHaveBeenCalledTimes(2);
  });

  it("fails visibly when the relations server repeats a pagination cursor", async () => {
    const { client, doRequest, redactEvent } = createReactionsClient([], "@me:example.org");
    doRequest.mockResolvedValue({ chunk: [], next_batch: "same-cursor" });

    await expect(removeMatrixReactions(ROOM, "$msg", { client })).rejects.toThrow(
      "repeated cursor",
    );
    expect(doRequest).toHaveBeenCalledTimes(2);
    expect(redactEvent).not.toHaveBeenCalled();
  });

  it("returns removed=0 when current user id is unavailable", async () => {
    const { client, redactEvent } = createReactionsClient([
      reaction("$1", "@me:example.org", "👍"),
    ]);

    await expect(removeMatrixReactions(ROOM, "$msg", { client })).resolves.toEqual({ removed: 0 });
    expect(redactEvent).not.toHaveBeenCalled();
  });

  it("rejects blank message ids before querying Matrix relations", async () => {
    const { client, doRequest } = createReactionsClient();

    await expect(listMatrixReactions(ROOM, "   ", { client })).rejects.toThrow("messageId");
    expect(doRequest).not.toHaveBeenCalled();
  });
});
