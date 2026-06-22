// Mattermost tests cover chat-type cache plugin behavior.
import { afterEach, describe, expect, it } from "vitest";
import {
  inferMattermostTargetChatType,
  recordMattermostChannelChatType,
  resetMattermostChatTypeCacheForTests,
} from "./chat-type-cache.js";

const PRIVATE_ID = "aaaaaaaaaaaaaaaaaaaaaaaaaa";
const PUBLIC_ID = "bbbbbbbbbbbbbbbbbbbbbbbbbb";

afterEach(() => {
  resetMattermostChatTypeCacheForTests();
});

describe("inferMattermostTargetChatType", () => {
  it("classifies an explicit user target as direct without a cache entry", () => {
    expect(inferMattermostTargetChatType(`user:${PRIVATE_ID}`)).toBe("direct");
  });

  it("returns undefined for an unknown channel id so core keeps its channel default", () => {
    expect(inferMattermostTargetChatType(`channel:${PRIVATE_ID}`)).toBeUndefined();
  });

  it("resolves a recorded private channel as group", () => {
    recordMattermostChannelChatType(PRIVATE_ID, "P");
    expect(inferMattermostTargetChatType(`channel:${PRIVATE_ID}`)).toBe("group");
    // A bare id (no prefix) resolves the same way.
    expect(inferMattermostTargetChatType(PRIVATE_ID)).toBe("group");
  });

  it("keeps a recorded public channel as channel", () => {
    recordMattermostChannelChatType(PUBLIC_ID, "O");
    expect(inferMattermostTargetChatType(`channel:${PUBLIC_ID}`)).toBe("channel");
  });

  it("ignores non-Mattermost ids and missing channel types", () => {
    recordMattermostChannelChatType("short", "P");
    recordMattermostChannelChatType(PRIVATE_ID, undefined);
    expect(inferMattermostTargetChatType(`channel:${PRIVATE_ID}`)).toBeUndefined();
  });
});
