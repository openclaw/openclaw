import { afterEach, expect, it } from "vitest";
import { rememberDiscordDirectoryUser, resolveDiscordDirectoryUserId } from "./directory-cache.js";
import { clearDiscordDirectoryCacheForTest } from "./directory-cache.test-support.js";

afterEach(clearDiscordDirectoryCacheForTest);

it("retains collisions through refresh and isolates account caches", () => {
  const first = "222333444555666777";
  const second = "333444555666777888";
  const remember = (userId: string, handles: string[], accountId = "work") =>
    rememberDiscordDirectoryUser({ accountId, userId, handles });
  const resolve = (handle: string, accountId = "work") =>
    resolveDiscordDirectoryUserId({ accountId, handle });
  remember(first, ["Alice#1234", "Reviewer"]);
  remember(first, ["Alice#1234"]);
  remember(second, ["Reviewer"]);
  remember(first, ["Reviewer"]);
  remember(second, ["Reviewer"], "personal");
  expect(resolve("Alice")).toBe(first);
  expect(resolve("@ALICE#1234")).toBe(first);
  expect.soft(resolve("Alice#9999")).toBeUndefined();
  expect.soft(resolve("Reviewer")).toBeUndefined();
  expect(resolve("Reviewer", "personal")).toBe(second);
  expect(resolve("Unknown")).toBeUndefined();
});

it("permits a fresh observation after an ambiguous entry is evicted", () => {
  const accountId = "work";
  rememberDiscordDirectoryUser({ accountId, userId: "1", handles: ["Reviewer"] });
  rememberDiscordDirectoryUser({ accountId, userId: "2", handles: ["Reviewer"] });
  for (let index = 0; index < 4_000; index += 1) {
    rememberDiscordDirectoryUser({ accountId, userId: "3", handles: [`user${index}`] });
  }
  rememberDiscordDirectoryUser({ accountId, userId: "2", handles: ["Reviewer"] });
  expect(resolveDiscordDirectoryUserId({ accountId, handle: "Reviewer" })).toBe("2");
});
