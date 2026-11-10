// Discord tests cover speaker context plugin behavior.
import { describe, expect, it, vi } from "vitest";
import type { Client } from "../internal/discord.js";
import {
  attachRestMock,
  createInternalTestClient,
} from "../internal/test-builders.test-support.js";
import { resolveDiscordVoiceAccess } from "./owner-access.js";
import { DiscordVoiceSpeakerContextResolver } from "./speaker-context.js";

function createClient(fetchMember: ReturnType<typeof vi.fn>): Client {
  return {
    fetchMember,
    fetchUser: vi.fn(),
  } as unknown as Client;
}

describe("DiscordVoiceSpeakerContextResolver", () => {
  it("reuses the client's member cache and observes Gateway member updates", async () => {
    const client = createInternalTestClient();
    const get = vi
      .fn()
      .mockResolvedValueOnce({
        nick: "Ada",
        roles: ["role-a"],
        user: { id: "u1", username: "ada" },
      })
      .mockResolvedValueOnce({
        nick: "Grace",
        roles: ["role-b"],
        user: { id: "u1", username: "grace" },
      });
    attachRestMock(client, { get });
    const resolver = new DiscordVoiceSpeakerContextResolver({ client });

    await expect(resolver.resolveContext("g1", "u1")).resolves.toEqual({
      id: "u1",
      label: "Ada",
      name: "ada",
      tag: "ada",
      memberRoleIds: ["role-a"],
      senderIsOwner: false,
    });
    await expect(resolver.resolveContext("g1", "u1")).resolves.toMatchObject({ label: "Ada" });
    expect(get).toHaveBeenCalledTimes(1);
    await client.dispatchGatewayEvent("GUILD_MEMBER_UPDATE", {
      guild_id: "g1",
      user: { id: "u1" },
    });
    await expect(resolver.resolveContext("g1", "u1")).resolves.toMatchObject({
      label: "Grace",
      memberRoleIds: ["role-b"],
    });
    expect(get.mock.calls.map(([route]) => route)).toEqual([
      "/guilds/g1/members/u1",
      "/guilds/g1/members/u1",
    ]);
  });

  it.each([
    { owner: "123456789012345678", senderIsOwner: true },
    { owner: "discord:123456789012345678", senderIsOwner: true },
    { owner: "user:123456789012345678", senderIsOwner: true },
    { owner: "pk:123456789012345678", senderIsOwner: true },
    { owner: "<@123456789012345678>", senderIsOwner: true },
    { owner: "<@!123456789012345678>", senderIsOwner: true },
    { owner: "discord:user:123456789012345678", senderIsOwner: true },
    { owner: "slack:123456789012345678", senderIsOwner: false },
    { owner: "discord:*", senderIsOwner: false },
    { owner: "user:*", senderIsOwner: false },
    { owner: "pk:*", senderIsOwner: false },
  ])("preserves owner target authority for voice: $owner", async ({ owner, senderIsOwner }) => {
    const id = "123456789012345678";
    const fetchMember = vi.fn().mockResolvedValue({ user: { id, username: "ada" } });
    const access = resolveDiscordVoiceAccess({
      cfg: { commands: { ownerAllowFrom: [owner] } },
      discordConfig: {},
      accountId: "default",
    });
    const resolver = new DiscordVoiceSpeakerContextResolver({
      client: createClient(fetchMember),
      ownerAllowFrom: access.ownerAllowFrom,
    });

    await expect(resolver.resolveContext("g1", id)).resolves.toMatchObject({ senderIsOwner });
  });
});
