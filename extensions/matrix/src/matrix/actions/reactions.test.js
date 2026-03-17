import { describe, expect, it, vi } from "vitest";
import { listMatrixReactions, removeMatrixReactions } from "./reactions.js";
function createReactionsClient(params) {
  const doRequest = vi.fn(async (_method, _path, _query) => ({
    chunk: params.chunk.map((item) => ({
      event_id: item.event_id ?? "",
      sender: item.sender ?? "",
      content: item.key ? {
        "m.relates_to": {
          rel_type: "m.annotation",
          event_id: "$target",
          key: item.key
        }
      } : {}
    }))
  }));
  const getUserId = vi.fn(async () => params.userId ?? null);
  const redactEvent = vi.fn(async () => void 0);
  return {
    client: {
      doRequest,
      getUserId,
      redactEvent,
      stop: vi.fn()
    },
    doRequest,
    redactEvent
  };
}
describe("matrix reaction actions", () => {
  it("aggregates reactions by key and unique sender", async () => {
    const { client, doRequest } = createReactionsClient({
      chunk: [
        { event_id: "$1", sender: "@alice:example.org", key: "\u{1F44D}" },
        { event_id: "$2", sender: "@bob:example.org", key: "\u{1F44D}" },
        { event_id: "$3", sender: "@alice:example.org", key: "\u{1F44E}" },
        { event_id: "$4", sender: "@bot:example.org" }
      ],
      userId: "@bot:example.org"
    });
    const result = await listMatrixReactions("!room:example.org", "$msg", { client, limit: 2.9 });
    expect(doRequest).toHaveBeenCalledWith(
      "GET",
      expect.stringContaining("/rooms/!room%3Aexample.org/relations/%24msg/"),
      expect.objectContaining({ limit: 2 })
    );
    expect(result).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "\u{1F44D}",
          count: 2,
          users: expect.arrayContaining(["@alice:example.org", "@bob:example.org"])
        }),
        expect.objectContaining({
          key: "\u{1F44E}",
          count: 1,
          users: ["@alice:example.org"]
        })
      ])
    );
  });
  it("removes only current-user reactions matching emoji filter", async () => {
    const { client, redactEvent } = createReactionsClient({
      chunk: [
        { event_id: "$1", sender: "@me:example.org", key: "\u{1F44D}" },
        { event_id: "$2", sender: "@me:example.org", key: "\u{1F44E}" },
        { event_id: "$3", sender: "@other:example.org", key: "\u{1F44D}" }
      ],
      userId: "@me:example.org"
    });
    const result = await removeMatrixReactions("!room:example.org", "$msg", {
      client,
      emoji: "\u{1F44D}"
    });
    expect(result).toEqual({ removed: 1 });
    expect(redactEvent).toHaveBeenCalledTimes(1);
    expect(redactEvent).toHaveBeenCalledWith("!room:example.org", "$1");
  });
  it("returns removed=0 when current user id is unavailable", async () => {
    const { client, redactEvent } = createReactionsClient({
      chunk: [{ event_id: "$1", sender: "@me:example.org", key: "\u{1F44D}" }],
      userId: null
    });
    const result = await removeMatrixReactions("!room:example.org", "$msg", { client });
    expect(result).toEqual({ removed: 0 });
    expect(redactEvent).not.toHaveBeenCalled();
  });
});
