import { expect, it, vi } from "vitest";
import reefChannelEntry from "../index.js";
import { reefPlugin } from "./channel.js";
import { autonomyBudget, parseReefRelayUrl, ReefChannelConfigSchema } from "./config-schema.js";
import { createReefRuntimeAuthority } from "./runtime.js";

const guardConfig = { pinnedModel: "test-model", policyVersion: "v1", timeoutMs: 5_000 };
const oauth = {
  ...guardConfig,
  authMode: "oauth",
  authProfileId: "openai:work",
  provider: "openai",
};

it.each([
  [{ guard: { ...oauth, provider: "anthropic" } }, false],
  [{ guard: { ...oauth, authProfileId: "" } }, false],
  [{ guard: { ...oauth, authProfileId: "openai:   " } }, false],
  [{ guard: { ...oauth, authProfileId: "openai:team/work" } }, false],
  [{ guard: { ...oauth, authProfileId: "anthropic:work" } }, false],
  [{ guard: { ...oauth, apiKeyEnv: "OPENAI_API_KEY" } }, false],
  [{ friends: { peer: { legacy: true } } }, true],
  [{ allowFrom: [] }, false],
  [{ dmPolicy: "pairing" }, false],
  [{ relayUrl: "https://relay.example/tenant" }, false],
  [{ relayUrl: "https://relay.example\\tenant" }, false],
  [{ relayUrl: "https://relay.example/?tenant=a" }, false],
  [{ relayUrl: "https://user@relay.example/" }, false],
  [{ relayUrl: "ftp://relay.example/" }, false],
] as const)("validates Reef config %j", (input, accepted) => {
  expect(ReefChannelConfigSchema.safeParse(input).success).toBe(accepted);
});

it("normalizes an origin-wide relay endpoint", () => {
  expect(parseReefRelayUrl("https://relay.example/")).toBe("https://relay.example");
});

it("keeps config mutation off the agent message surface and gates owner commands", async () => {
  const registerCommand = vi.fn();
  reefChannelEntry.register({ registrationMode: "tool-discovery", registerCommand } as never);
  expect(registerCommand).toHaveBeenCalledOnce();
  const command = registerCommand.mock.calls[0]![0];
  expect(command).toMatchObject({ name: "reef", requireAuth: true, exposeSenderIsOwner: true });
  const run = (args: string, senderIsOwner = false) => command.handler({ args, senderIsOwner });

  const flowSend = vi.fn();
  const friends = { mintCode: vi.fn(), request: vi.fn(), remove: vi.fn(), setAutonomy: vi.fn() };
  const decide = vi.fn().mockResolvedValue(true);
  const listFriends = vi.fn().mockResolvedValue([]);
  createReefRuntimeAuthority().activate({
    flow: { send: flowSend },
    friends: { ...friends, list: listFriends },
    reviews: { list: vi.fn(), decide },
  } as never);
  const ownerRequired = {
    text: "Only an authorized owner can change Reef friends or decide reviews. Ask an owner; friendship changes can also use openclaw reef locally.",
  };
  const review = `review approve ${"a".repeat(64)}`;
  const autonomy = "friend autonomy peer extended";
  for (const args of [
    autonomy,
    review,
    "friend code",
    "friend request peer code",
    "friend remove peer",
  ]) {
    await expect(run(args)).resolves.toEqual(ownerRequired);
  }
  for (const mutation of [...Object.values(friends), decide]) {
    expect(mutation).not.toHaveBeenCalled();
  }

  await expect(run("friend list")).resolves.toEqual({ text: "No Reef friends." });
  expect(listFriends).toHaveBeenCalledOnce();

  await expect(run(autonomy, true)).resolves.toEqual({
    text: "Reef friend @peer autonomy set to extended.",
  });
  await expect(run(review, true)).resolves.toEqual({
    text: "Reef review approved. Retry the identical message to re-run the guard.",
  });
  expect(friends.setAutonomy).toHaveBeenCalledWith("peer", "extended", undefined);
  expect(decide).toHaveBeenCalledWith("a".repeat(64), true, undefined);

  await expect(run("config relayUrl https://attacker.example", true)).resolves.toEqual({
    text: expect.stringContaining("Usage: /reef friend"),
  });
  expect(flowSend).not.toHaveBeenCalled();
});

it("keeps read-only account and security inspection safe before runtime setup", async () => {
  const guard = { ...guardConfig, provider: "anthropic" as const, apiKeyEnv: "REEF_GUARD_API_KEY" };
  const cfg = { channels: { reef: { handle: "owner", email: "owner@example.com", guard } } };
  const account = reefPlugin.config.resolveAccount(cfg, "default");

  expect(await reefPlugin.config.resolveAllowFromAsync?.({ cfg, accountId: "default" })).toEqual(
    [],
  );
  expect(await reefPlugin.config.describeAccountAsync?.(account, cfg)).toMatchObject({
    extra: { friendCount: 0 },
  });
  expect(
    await reefPlugin.security?.resolveDmPolicyAsync?.({ cfg, accountId: "default", account }),
  ).toMatchObject({ policy: "pairing", allowFrom: [] });
});
it.each([
  ["notify-only", true, 1, 86_400],
  ["bounded", false, 3, 86_400],
  ["extended", false, 12, 3_600],
] as const)(
  "maps %s to notify and bot-loop turn budget",
  (autonomy, notifyOnly, maxEventsPerWindow, windowSeconds) => {
    expect(autonomyBudget(autonomy)).toEqual({
      notifyOnly,
      botLoopProtection: {
        enabled: true,
        maxEventsPerWindow,
        windowSeconds,
        cooldownSeconds: 86_400,
      },
    });
  },
);
