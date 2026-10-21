import { createDirectoryTestRuntime } from "openclaw/plugin-sdk/channel-test-helpers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { msteamsPlugin } from "./channel.js";

const lookups = vi.hoisted(() => ({ users: vi.fn(), channels: vi.fn() }));
vi.mock("./resolve-allowlist.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./resolve-allowlist.js")>()),
  resolveMSTeamsUserAllowlist: lookups.users,
  resolveMSTeamsChannelAllowlist: lookups.channels,
}));

const resolve = msteamsPlugin.resolver!.resolveTargets;
const userId = "11111111-1111-1111-1111-111111111111";
const chatId = "19:chat@thread.tacv2";
const entry = (input: string, fields: Record<string, unknown> = {}) => ({
  input,
  resolved: false,
  id: undefined,
  name: undefined,
  note: undefined,
  ...fields,
});

describe("Teams target resolution", () => {
  beforeEach(() => vi.resetAllMocks());

  it("keeps direct user IDs and email targets in place around directory results", async () => {
    lookups.users.mockResolvedValue([
      { input: "Jane", resolved: true, id: "jane-id", name: "Jane Doe" },
      { input: "Missing", resolved: false, note: "user not found" },
    ]);
    const result = await resolve({
      cfg: {},
      inputs: [" ", `user:${userId}`, "jane@example.test", "Jane", "Missing"],
      kind: "user",
      runtime: createDirectoryTestRuntime(),
    });
    expect(result).toEqual([
      entry(" ", { note: "empty input" }),
      entry(`user:${userId}`, { resolved: true, id: userId }),
      entry("jane@example.test", { resolved: true, id: "jane@example.test" }),
      entry("Jane", { resolved: true, id: "jane-id", name: "Jane Doe" }),
      entry("Missing", { note: "user not found" }),
    ]);
  });

  it("preserves conversation selectors and team/channel result labels", async () => {
    lookups.channels.mockResolvedValue([
      { input: "Ops", resolved: true, teamId: "team-id", teamName: "Ops" },
      {
        input: "Ops/General",
        resolved: true,
        teamId: "team-id",
        teamName: "Ops",
        channelId: "channel-id",
        channelName: "General",
        note: "matched",
      },
    ]);
    const result = await resolve({
      cfg: {},
      inputs: ["", "conversation:", `conversation:${chatId}`, "teams:", "Ops", "Ops/General"],
      kind: "group",
      runtime: createDirectoryTestRuntime(),
    });
    expect(result).toEqual([
      entry("", { note: "empty input" }),
      entry("conversation:", { note: "empty conversation id" }),
      entry(`conversation:${chatId}`, { resolved: true, id: chatId, note: "conversation id" }),
      entry("teams:", { note: "missing team" }),
      entry("Ops", { resolved: true, id: "team-id", name: "Ops", note: "team id" }),
      entry("Ops/General", {
        resolved: true,
        id: "team-id/channel-id",
        name: "Ops/General",
        note: "matched",
      }),
    ]);
  });

  it.each(["user", "group"] as const)(
    "keeps direct %s results when directory lookup fails",
    async (kind) => {
      const directInput = kind === "user" ? `user:${userId}` : `conversation:${chatId}`;
      lookups.users.mockRejectedValue(new Error("directory unavailable"));
      lookups.channels.mockRejectedValue(new Error("directory unavailable"));
      expect(
        await resolve({
          cfg: {},
          inputs: [directInput, "Missing"],
          kind,
          runtime: createDirectoryTestRuntime(),
        }),
      ).toEqual([
        entry(directInput, {
          resolved: true,
          id: kind === "user" ? userId : chatId,
          ...(kind === "group" ? { note: "conversation id" } : {}),
        }),
        entry("Missing", { note: "lookup failed" }),
      ]);
    },
  );
});
