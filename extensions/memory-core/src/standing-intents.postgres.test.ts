import { createOpenClawTestState, type OpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { postgresProductScope } from "./postgres-product.test-support.js";
import {
  cancelStandingIntent as cancel,
  createStandingIntent,
  encodeStandingIntentChannelScope as channelScope,
  encodeStandingIntentSenderScope as senderScope,
  listStandingIntents as list,
  matchStandingIntents,
} from "./standing-intents.js";

const database = postgresProductScope("intentsearch");
const selected = database.select;

describe.skipIf(!database.connection)("PostgreSQL standing intent product flow", () => {
  let state: OpenClawTestState;
  const create = (
    description: string,
    options: Partial<Parameters<typeof createStandingIntent>[0]> = {},
  ) =>
    selected(() =>
      createStandingIntent({
        agentId: "main",
        description,
        triggerKeywords: ["copper lantern"],
        creatorSender: "creator",
        nowMs: 1_000,
        expiresAt: 1_000_000,
        cooldownSeconds: 1,
        ...options,
      }),
    );
  const match = (options: Partial<Parameters<typeof matchStandingIntents>[0]> = {}) =>
    selected(() =>
      matchStandingIntents({
        agentId: "main",
        prompt: "The copper lantern is ready",
        nowMs: 2_000,
        provider: "discord",
        channel: "room",
        senderId: "owner",
        ...options,
      }),
    );

  beforeAll(async () => {
    state = await createOpenClawTestState({ prefix: "intents-pg-", layout: "state-only" });
    await database.connect();
  });

  afterAll(async () => {
    try {
      await state.cleanup();
    } finally {
      await database.close();
    }
  });

  it("filters channel, sender, lifecycle and agent before bounded candidate selection", async () => {
    const channel = (conversationId: string) =>
      channelScope({ scope: "conversation", provider: "discord", conversationId });
    const sender = (senderId: string) => senderScope({ provider: "discord", senderId });
    for (let index = 0; index < 34; index++) {
      await create(
        `excluded ${index}`,
        index % 2 ? { channelScope: channel("elsewhere") } : { senderScope: sender("other") },
      );
    }
    await create("expired", { expiresAt: 1_500 });
    await create("foreign agent", { agentId: "other" });
    const intended = await create("visible", {
      channelScope: channel("room"),
      senderScope: sender("owner"),
    });
    expect((await match()).map((intent) => intent.id)).toEqual([intended.id]);
    expect(await match()).toEqual([]);
    expect((await match({ nowMs: 3_000 })).map((intent) => intent.id)).toEqual([intended.id]);
    const cancelled = await selected(() => cancel({ agentId: "main", id: intended.id }));
    expect(cancelled).toMatchObject({ status: "cancelled" });
    expect(await match({ nowMs: 4_000 })).toEqual([]);
    const listed = await selected(() => list({ agentId: "main", nowMs: 4_000 }));
    expect(listed.find((intent) => intent.description === "expired")?.status).toBe("expired");
  });

  it("keeps exact keyword groups and injection bounds through the real matching API", async () => {
    const created: Array<Awaited<ReturnType<typeof create>>> = [];
    for (let index = 0; index < 4; index++) {
      created.push(await create(`bounded ${index}`, { triggerKeywords: ["sapphire beacon"] }));
    }
    expect(await match({ prompt: "sapphire" })).toEqual([]);
    const found = await match({ prompt: "sapphire & (beacon) | ! unrelated" });
    expect(found).toHaveLength(3);
    expect(found.every((intent) => created.some((item) => item.id === intent.id))).toBe(true);
    expect(await match({ prompt: "  " })).toEqual([]);
    expect(await match({ prompt: "& | ! ()" })).toEqual([]);
    expect(await match({ prompt: "x".repeat(4096) })).toEqual([]);
    const late = await create("late prompt trigger", { triggerKeywords: ["amethyst orbit"] });
    const prompt = `${Array.from({ length: 1000 }, (_, index) => `unrelated${index}`).join(" ")} amethyst orbit`;
    expect((await match({ prompt })).map((intent) => intent.id)).toEqual([late.id]);
  });
});
