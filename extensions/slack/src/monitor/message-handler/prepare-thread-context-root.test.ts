import { describe, expect, it } from "vitest";
import { isSlackThreadAuthorCurrentBot } from "./prepare-thread-context-root.js";

describe("isSlackThreadAuthorCurrentBot", () => {
  const identity = { botUserId: "U_BOT", botId: "B1" };

  it.each([
    ["matches the configured bot user id", identity, { userId: "U_BOT" }, true],
    ["matches the configured bot id", identity, { botId: "B1" }, true],
    ["does not match a different bot id", identity, { botId: "B2" }, false],
    ["does not match a regular user", identity, { userId: "U1" }, false],
    ["returns false when identity has no bot ids", {}, { userId: "U_BOT", botId: "B1" }, false],
  ] as const)("%s", (_name, botIdentity, author, expected) => {
    expect(isSlackThreadAuthorCurrentBot({ identity: botIdentity, author })).toBe(expected);
  });
});
