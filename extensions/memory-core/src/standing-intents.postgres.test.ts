import { randomUUID } from "node:crypto";
import { getEnvironmentData } from "node:worker_threads";
import {
  withDatabaseEngineSelection,
  resolveDatabaseFamilyEngines,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { createOpenClawTestState, type OpenClawTestState } from "openclaw/plugin-sdk/test-state";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  cancelStandingIntent,
  createStandingIntent,
  encodeStandingIntentChannelScope,
  encodeStandingIntentSenderScope,
  listStandingIntents,
  matchStandingIntents,
} from "./standing-intents.js";

const configured = getEnvironmentData("openclaw.test.workboard.connection");
const connection = typeof configured === "string" ? configured : undefined;
const prefix = `intentsearch_${randomUUID().replaceAll("-", "").slice(0, 10)}`;
const selection = {
  effectiveEngines: resolveDatabaseFamilyEngines({ database: { engine: "postgres" } }),
  postgres: { connection: connection!, schemaPrefix: prefix },
};
const selected = <T>(run: () => T) => withDatabaseEngineSelection(selection, run);

describe.skipIf(!connection)("PostgreSQL standing intent product flow", () => {
  let state: OpenClawTestState;
  const client = new pg.Client({ connectionString: connection });
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
        maxFires: 3,
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
    state = await createOpenClawTestState({
      prefix: "standing-intents-postgres-",
      layout: "state-only",
    });
    await client.connect();
  });

  afterAll(async () => {
    if (!connection) {
      return;
    }
    try {
      await state.cleanup();
      const schemas = await client.query<{ nspname: string }>(
        "SELECT nspname FROM pg_namespace WHERE left(nspname, $1) = $2",
        [prefix.length + 1, `${prefix}_`],
      );
      for (const { nspname } of schemas.rows) {
        await client.query(`DROP SCHEMA "${nspname}" CASCADE`);
      }
    } finally {
      await client.end();
    }
  });

  it("filters channel, sender, lifecycle and agent before bounded candidate selection", async () => {
    const foreignChannel = encodeStandingIntentChannelScope({
      scope: "conversation",
      provider: "discord",
      conversationId: "elsewhere",
    });
    const foreignSender = encodeStandingIntentSenderScope({
      provider: "discord",
      senderId: "other",
    });
    for (let index = 0; index < 34; index++) {
      await create(
        `excluded ${index}`,
        index % 2 ? { channelScope: foreignChannel } : { senderScope: foreignSender },
      );
    }
    await create("expired", { expiresAt: 1_500 });
    await create("foreign agent", { agentId: "other" });
    const intended = await create("visible", {
      channelScope: encodeStandingIntentChannelScope({
        scope: "conversation",
        provider: "discord",
        conversationId: "room",
      }),
      senderScope: encodeStandingIntentSenderScope({ provider: "discord", senderId: "owner" }),
    });
    expect((await match()).map((intent) => intent.id)).toEqual([intended.id]);
    expect(await match()).toEqual([]);
    expect((await match({ nowMs: 3_000 })).map((intent) => intent.id)).toEqual([intended.id]);
    expect(
      await selected(() => cancelStandingIntent({ agentId: "main", id: intended.id })),
    ).toMatchObject({
      status: "cancelled",
    });
    expect(await match({ nowMs: 4_000 })).toEqual([]);
    expect(
      (await selected(() => listStandingIntents({ agentId: "main", nowMs: 4_000 }))).find(
        (intent) => intent.description === "expired",
      ),
    ).toMatchObject({ status: "expired" });
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
