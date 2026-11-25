import { createDirectoryTestRuntime } from "openclaw/plugin-sdk/channel-test-helpers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { msteamsPlugin } from "./channel.js";

const lookups = vi.hoisted(() => ({ users: vi.fn(), channels: vi.fn() }));
vi.mock("./resolve-allowlist.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./resolve-allowlist.js")>()),
  resolveMSTeamsUserAllowlist: lookups.users,
  resolveMSTeamsChannelAllowlist: lookups.channels,
}));
const userId = "11111111-1111-1111-1111-111111111111";
const chatId = "19:chat@thread.tacv2";
const resolve = async (kind: "user" | "group", inputs: string[]) =>
  (
    await msteamsPlugin.resolver!.resolveTargets({
      cfg: {},
      inputs,
      kind,
      runtime: createDirectoryTestRuntime(),
    })
  ).map(({ input, resolved, id, name, note }) => [input, resolved, id, name, note]);

describe("Teams target resolution", () => {
  beforeEach(() => vi.resetAllMocks());

  it("preserves direct user IDs, email targets and directory results in order", async () => {
    lookups.users.mockResolvedValue([
      { input: "Jane", resolved: true, id: "jane-id", name: "Jane Doe" },
      { input: "Missing", resolved: false, note: "user not found" },
    ]);
    expect(
      await resolve("user", [" ", `user:${userId}`, "jane@example.test", "Jane", "Missing"]),
    ).toEqual([
      [" ", false, undefined, undefined, "empty input"],
      [`user:${userId}`, true, userId, undefined, undefined],
      ["jane@example.test", true, "jane@example.test", undefined, undefined],
      ["Jane", true, "jane-id", "Jane Doe", undefined],
      ["Missing", false, undefined, undefined, "user not found"],
    ]);
  });

  it("preserves conversation selectors and team/channel labels", async () => {
    lookups.channels.mockResolvedValue([
      { input: "Ops", resolved: true, teamId: "team", teamName: "Ops" },
      {
        input: "Ops/General",
        resolved: true,
        teamId: "team",
        teamName: "Ops",
        channelId: "channel",
        channelName: "General",
        note: "matched",
      },
    ]);
    expect(
      await resolve("group", [
        "",
        "conversation:",
        `conversation:${chatId}`,
        "teams:",
        "Ops",
        "Ops/General",
      ]),
    ).toEqual([
      ["", false, undefined, undefined, "empty input"],
      ["conversation:", false, undefined, undefined, "empty conversation id"],
      [`conversation:${chatId}`, true, chatId, undefined, "conversation id"],
      ["teams:", false, undefined, undefined, "missing team"],
      ["Ops", true, "team", "Ops", "team id"],
      ["Ops/General", true, "team/channel", "Ops/General", "matched"],
    ]);
  });

  it.each(["user", "group"] as const)("keeps direct %s results when lookup fails", async (kind) => {
    const direct = kind === "user" ? `user:${userId}` : `conversation:${chatId}`;
    lookups.users.mockRejectedValue(new Error("directory unavailable"));
    lookups.channels.mockRejectedValue(new Error("directory unavailable"));
    expect(await resolve(kind, [direct, "Missing"])).toEqual([
      [
        direct,
        true,
        kind === "user" ? userId : chatId,
        undefined,
        kind === "group" ? "conversation id" : undefined,
      ],
      ["Missing", false, undefined, undefined, "lookup failed"],
    ]);
  });
});
