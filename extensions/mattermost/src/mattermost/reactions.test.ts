import { beforeEach, describe, expect, it } from "vitest";
import {
  addMattermostReaction,
  removeMattermostReaction,
  resetMattermostReactionBotUserCacheForTests,
} from "./reactions.js";
import {
  createMattermostReactionFetchMock,
  createMattermostTestConfig,
} from "./reactions.test-helpers.js";

describe("mattermost reactions", () => {
  beforeEach(() => {
    resetMattermostReactionBotUserCacheForTests();
  });

  it("adds reactions by calling /users/me then POST /reactions", async () => {
    const fetchMock = createMattermostReactionFetchMock({
      mode: "add",
      postId: "POST1",
      emojiName: "thumbsup",
    });

    const result = await addMattermostReaction({
      cfg: createMattermostTestConfig(),
      postId: "POST1",
      emojiName: "thumbsup",
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    expect(result).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalled();
  });

  it("returns a Result error when add reaction API call fails", async () => {
    const fetchMock = createMattermostReactionFetchMock({
      mode: "add",
      postId: "POST1",
      emojiName: "thumbsup",
      status: 500,
      body: { id: "err", message: "boom" },
    });

    const result = await addMattermostReaction({
      cfg: createMattermostTestConfig(),
      postId: "POST1",
      emojiName: "thumbsup",
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("Mattermost add reaction failed");
    }
  });

  it("removes reactions by calling /users/me then DELETE /users/:id/posts/:postId/reactions/:emoji", async () => {
    const fetchMock = createMattermostReactionFetchMock({
      mode: "remove",
      postId: "POST1",
      emojiName: "thumbsup",
    });

    const result = await removeMattermostReaction({
      cfg: createMattermostTestConfig(),
      postId: "POST1",
      emojiName: "thumbsup",
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    expect(result).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalled();
  });

  it("caches the bot user id across reaction mutations", async () => {
    const fetchMock = createMattermostReactionFetchMock({
      mode: "both",
      postId: "POST1",
      emojiName: "thumbsup",
    });

    const cfg = createMattermostTestConfig();
    const addResult = await addMattermostReaction({
      cfg,
      postId: "POST1",
      emojiName: "thumbsup",
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    const removeResult = await removeMattermostReaction({
      cfg,
      postId: "POST1",
      emojiName: "thumbsup",
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    const usersMeCalls = fetchMock.mock.calls.filter((call) =>
      String(call[0]).endsWith("/api/v4/users/me"),
    );
    expect(addResult).toEqual({ ok: true });
    expect(removeResult).toEqual({ ok: true });
    expect(usersMeCalls).toHaveLength(1);
  });
});
