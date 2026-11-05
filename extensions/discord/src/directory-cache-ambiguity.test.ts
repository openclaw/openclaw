import { afterEach, expect, it } from "vitest";
import { discordDirectoryCacheState } from "./directory-cache-state.js";
import { rememberDiscordDirectoryUser, resolveDiscordDirectoryUserId } from "./directory-cache.js";

const accountId = "directory-ambiguity-regression";
afterEach(() => {
  discordDirectoryCacheState.handlesByAccount.delete(accountId);
});
it("retains collisions and refuses unknown discriminator fallbacks", () => {
  const first = "222333444555666777";
  rememberDiscordDirectoryUser({ accountId, userId: first, handles: ["Alice#1234", "Reviewer"] });
  rememberDiscordDirectoryUser({ accountId, userId: "333444555666777888", handles: ["Reviewer"] });
  rememberDiscordDirectoryUser({ accountId, userId: first, handles: ["Reviewer"] });
  const resolve = (handle: string) => resolveDiscordDirectoryUserId({ accountId, handle });
  expect(resolve("Alice")).toBe(first);
  expect(resolve("Alice#1234")).toBe(first);
  expect(resolve("Alice#9999")).toBeUndefined();
  expect(resolve("Reviewer")).toBeUndefined();
  expect(resolve("Unknown")).toBeUndefined();
});
