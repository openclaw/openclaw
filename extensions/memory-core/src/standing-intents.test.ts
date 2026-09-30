import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  openNodeSqliteDatabase,
  openOpenClawAgentDatabase,
  resolveOpenClawAgentSqlitePath,
  runSqliteImmediateTransactionSync,
} from "openclaw/plugin-sdk/sqlite-runtime";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  listStandingIntentsInDatabase,
  matchStandingIntentsInDatabase,
} from "./standing-intents-kernel.js";
import { prepareStandingIntentMatch } from "./standing-intents-model.js";
import { createStandingIntentExecutor } from "./standing-intents-tool.js";
import {
  buildStandingIntentContext,
  cancelStandingIntent,
  createStandingIntent as createStandingIntentRaw,
  DEFAULT_INTENT_COOLDOWN_SECONDS,
  DEFAULT_INTENT_EXPIRY_MS,
  DEFAULT_INTENT_MAX_FIRES,
  encodeStandingIntentChannelScope,
  encodeStandingIntentSenderScope,
  INTENT_INJECTION_MAX_CHARS,
  isEligibleStandingIntentTurn,
  listStandingIntents,
  matchStandingIntents,
  sweepStandingIntents,
} from "./standing-intents.js";

function createStandingIntent(
  params: Omit<Parameters<typeof createStandingIntentRaw>[0], "creatorSender">,
) {
  return createStandingIntentRaw({ ...params, creatorSender: "owner-sender" });
}

function parseToolJson(
  result: Awaited<ReturnType<ReturnType<typeof createStandingIntentExecutor>>>,
) {
  const text = result.content.find((entry) => entry.type === "text")?.text;
  return JSON.parse(text ?? "null") as Record<string, unknown>;
}

describe("standing intents", () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-standing-intents-")),
    );
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    await fs.mkdir(path.dirname(resolveOpenClawAgentSqlitePath({ agentId: "main" })), {
      recursive: true,
    });
  });

  afterEach(async () => {
    await closeOpenClawAgentDatabasesAsync();
    closeOpenClawAgentDatabasesForTest();
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    vi.unstubAllEnvs();
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  it("lazy-ensures the additive table idempotently", async () => {
    const first = await createStandingIntent({
      agentId: "main",
      description: "Mention the launch checklist.",
      triggerKeywords: ["launch checklist"],
      nowMs: 1_000,
    });
    const second = await createStandingIntent({
      agentId: "main",
      description: "Mention the rollback owner.",
      triggerKeywords: ["rollback owner"],
      nowMs: 2_000,
    });

    expect(first.id).not.toBe(second.id);
    expect(await listStandingIntents({ agentId: "main", nowMs: 2_000 })).toHaveLength(2);
  });

  it("retains first-use schema after a failed create and retries without duplicate intents", async () => {
    const databasePath = resolveOpenClawAgentSqlitePath({ agentId: "main" });
    const db = openOpenClawAgentDatabase({ agentId: "main" }).db;
    db.exec("DROP TABLE standing_intents; DROP TABLE standing_intents_fts");
    expect(
      db.prepare("SELECT name FROM sqlite_schema WHERE name GLOB '*standing_intents*'").all(),
    ).toEqual([]);
    await closeOpenClawAgentDatabasesAsync();
    closeOpenClawAgentDatabasesForTest();

    await expect(
      createStandingIntent({
        agentId: "main",
        description: "Mention the migration rehearsal.",
        triggerKeywords: ["migration rehearsal"],
        maxFires: 0,
        nowMs: 1_000,
      }),
    ).rejects.toThrow("CHECK constraint failed: max_fires > 0");
    await closeOpenClawAgentDatabasesAsync();
    closeOpenClawAgentDatabasesForTest();

    // Inspect durable state without an agent open that could repair the schema.
    const reopened = openNodeSqliteDatabase(databasePath, { readOnly: true });
    try {
      expect(
        reopened
          .prepare(
            "SELECT name FROM sqlite_schema WHERE name IN ('standing_intents', 'standing_intents_fts') ORDER BY name",
          )
          .all()
          .map((row) => row.name),
      ).toEqual(["standing_intents", "standing_intents_fts"]);
      expect(reopened.prepare("SELECT COUNT(*) AS count FROM standing_intents").get()?.count).toBe(
        0,
      );
    } finally {
      reopened.close();
    }

    const created = await createStandingIntent({
      agentId: "main",
      description: "Mention the migration rehearsal.",
      triggerKeywords: ["migration rehearsal"],
      maxFires: 1,
      nowMs: 2_000,
    });
    expect(
      (
        await matchStandingIntents({
          agentId: "main",
          prompt: "migration rehearsal",
          nowMs: 2_000,
        })
      ).map((intent) => intent.id),
    ).toEqual([created.id]);
    const stored = await listStandingIntents({ agentId: "main", nowMs: 2_000 });
    expect(stored.map((intent) => intent.id)).toEqual([created.id]);
    expect(stored[0]).toMatchObject({ status: "done", fireCount: 1 });
  });

  it("creates, lists, and explicitly cancels through the agent tool", async () => {
    const execute = createStandingIntentExecutor({
      agentId: "main",
      sourceSessionId: "session-1",
      conversationId: "qa-dm-5",
      provider: "qa-channel",
      senderId: "alice",
    });
    const createResult = parseToolJson(
      await execute("call-1", {
        action: "create",
        description: "Ask whether the migration was rehearsed.",
        triggerKeywords: ["migration", "rehearsal"],
      }),
    );
    const created = createResult.intent as {
      id: string;
      channelScope: string | null;
      senderScope: string | null;
      status: string;
    };
    expect(created).toMatchObject({
      channelScope: "qa-channel",
      senderScope: "alice",
      creatorSender: "alice",
      status: "armed",
    });
    expect(createResult.message).toBe(
      "Intent is armed for this channel. The system injects the reminder automatically when it triggers. Do not deliver it early or cancel it unless the user asks.",
    );
    const listResult = parseToolJson(await execute("call-2", { action: "list" }));
    const listed = listResult.intents as Array<{ id: string; sourceSessionId: string }>;

    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ id: created.id, sourceSessionId: "session-1" });

    const cancelResult = parseToolJson(
      await execute("call-3", { action: "cancel", id: created.id }),
    );
    expect(cancelResult.cancelled).toBe(true);
    expect(await cancelStandingIntent({ agentId: "main", id: created.id })).toBeNull();
  });

  it("injects owner-created intents and skips rows without a known creator", async () => {
    const execute = createStandingIntentExecutor({
      agentId: "main",
      conversationId: "qa-dm-5",
      provider: "qa-channel",
      senderId: "owner-1",
    });
    const created = parseToolJson(
      await execute("create-owner-intent", {
        action: "create",
        description: "Use the owner-authored reminder.",
        triggerKeywords: ["owner signal"],
      }),
    ).intent as { id: string };
    expect(
      (
        await matchStandingIntents({
          agentId: "main",
          prompt: "owner signal",
          channel: "qa-dm-5",
          provider: "qa-channel",
          senderId: "owner-1",
          nowMs: Date.now(),
        })
      ).map((intent) => intent.id),
    ).toEqual([created.id]);

    const db = openOpenClawAgentDatabase({ agentId: "main" }).db;
    const insertUnknownCreator = db.prepare(
      `INSERT INTO standing_intents (
        id, description, trigger_keywords, trigger_embedding, channel_scope, sender_scope,
        creator_sender, status, expires_at, max_fires, fire_count, cooldown_seconds,
        last_fired_at, created_at, source_session_id
      ) VALUES (?, ?, ?, NULL, NULL, NULL, ?, 'armed', ?, 1, 0, 0, NULL, ?, NULL)`,
    );
    const expiresAt = Date.now() + 60_000;
    insertUnknownCreator.run(
      "missing-creator",
      "Missing creator must not inject.",
      JSON.stringify(["missing creator signal"]),
      null,
      expiresAt,
      Date.now(),
    );
    insertUnknownCreator.run(
      "unknown-creator",
      "Unknown creator must not inject.",
      JSON.stringify(["unknown creator signal"]),
      "unknown",
      expiresAt,
      Date.now(),
    );

    expect(
      await matchStandingIntents({
        agentId: "main",
        prompt: "missing creator signal and unknown creator signal",
        nowMs: Date.now(),
      }),
    ).toEqual([]);
  });

  it("derives typed conversation, channel, anywhere, sender, and anyone scopes", async () => {
    const execute = createStandingIntentExecutor({
      agentId: "main",
      conversationId: "QA-DM-5",
      provider: "QA-CHANNEL",
      senderId: "alice",
    });
    const conversationResult = parseToolJson(
      await execute("call-conversation", {
        action: "create",
        description: "Use the conversation reminder.",
        triggerKeywords: ["conversation reminder"],
        scope: "conversation",
        senderScope: "anyone",
      }),
    );
    expect(conversationResult.intent).toMatchObject({
      channelScope: "QA-DM-5",
      senderScope: null,
    });
    expect(conversationResult.message).toContain("Intent is armed for this conversation.");
    expect(
      await matchStandingIntents({
        agentId: "main",
        prompt: "conversation reminder",
        channel: "QA-DM-5",
        provider: "qa-channel",
        senderId: "bob",
      }),
    ).toHaveLength(1);

    const anywhereResult = parseToolJson(
      await execute("call-anywhere", {
        action: "create",
        description: "Use the global reminder.",
        triggerKeywords: ["global reminder"],
        scope: "anywhere",
      }),
    );
    expect(anywhereResult.intent).toMatchObject({
      channelScope: null,
      senderScope: "alice",
    });
    expect(anywhereResult.message).toContain("Intent is armed everywhere.");
  });

  it("refuses senderless creation instead of exposing it to unrelated channel users", async () => {
    const execute = createStandingIntentExecutor({ agentId: "main" });

    expect(parseToolJson(await execute("list-empty", { action: "list" }))).toEqual({
      intents: [],
    });
    await expect(
      execute("create-default", {
        action: "create",
        description: "Identity-free reminder.",
        triggerKeywords: ["identity free"],
      }),
    ).rejects.toThrow("authenticated channel and sender identity is unavailable");

    expect(await listStandingIntents({ agentId: "main" })).toEqual([]);
    expect(
      await matchStandingIntents({
        agentId: "main",
        prompt: "identity free",
        provider: "qa-channel",
        channel: "unrelated-room",
        senderId: "unrelated-user",
      }),
    ).toEqual([]);
  });

  it("applies scope, cooldown, fire-budget, and expiry transitions", async () => {
    const created = await createStandingIntent({
      agentId: "main",
      description: "Surface the review checklist.",
      triggerKeywords: ["review checklist"],
      channelScope: encodeStandingIntentChannelScope({ scope: "channel", provider: "slack" }),
      senderScope: encodeStandingIntentSenderScope({ provider: "slack", senderId: "alice" }),
      maxFires: 2,
      cooldownSeconds: 60,
      expiresAt: 200_000,
      nowMs: 1_000,
    });

    expect(
      await matchStandingIntents({
        agentId: "main",
        prompt: "Can we review the checklist?",
        channel: "qa-dm-5",
        provider: "discord",
        senderId: "alice",
        nowMs: 2_000,
      }),
    ).toStrictEqual([]);

    const first = await matchStandingIntents({
      agentId: "main",
      prompt: "Can we review the checklist?",
      channel: "qa-dm-5",
      provider: "slack",
      senderId: "alice",
      nowMs: 2_000,
    });
    expect(first[0]).toMatchObject({ id: created.id, status: "fired", fireCount: 1 });
    expect(
      await matchStandingIntents({
        agentId: "main",
        prompt: "Review checklist again",
        channel: "qa-dm-5",
        provider: "slack",
        senderId: "alice",
        nowMs: 61_999,
      }),
    ).toStrictEqual([]);

    const second = await matchStandingIntents({
      agentId: "main",
      prompt: "Review checklist again",
      channel: "qa-dm-5",
      provider: "slack",
      senderId: "alice",
      nowMs: 62_000,
    });
    expect(second[0]).toMatchObject({ id: created.id, status: "done", fireCount: 2 });
    expect(
      await matchStandingIntents({
        agentId: "main",
        prompt: "Review checklist once more",
        channel: "qa-dm-5",
        provider: "slack",
        senderId: "alice",
        nowMs: 130_000,
      }),
    ).toStrictEqual([]);

    await createStandingIntent({
      agentId: "main",
      description: "Expired intent.",
      triggerKeywords: ["expired signal"],
      expiresAt: 150_000,
      nowMs: 1_000,
    });
    await sweepStandingIntents({ agentId: "main", nowMs: 150_000 });
    expect(
      await listStandingIntents({ agentId: "main", status: "expired", nowMs: 150_000 }),
    ).toHaveLength(1);
  });

  it("rearms a cooled cohort in the kernel without per-intent writes or reminder payloads", async () => {
    const created: Awaited<ReturnType<typeof createStandingIntent>>[] = [];
    for (let index = 0; index < 32; index += 1) {
      created.push(
        await createStandingIntent({
          agentId: "main",
          description: `Review reminder ${index}.`.padEnd(120, " Use the reviewed checklist."),
          triggerKeywords: [
            "cohort review",
            "release checklist",
            "rollback owner",
            "migration review",
          ],
          cooldownSeconds: 60,
          maxFires: 3,
          nowMs: 1_000 + index,
        }),
      );
    }
    for (let index = 0; index < Math.ceil(created.length / 3); index += 1) {
      await matchStandingIntents({ agentId: "main", prompt: "cohort review", nowMs: 2_000 });
    }
    for (const intent of created) {
      intent.status = "fired";
      intent.fireCount = 1;
      intent.lastFiredAt = 2_000;
    }
    expect(await listStandingIntents({ agentId: "main", nowMs: 61_999 })).toEqual(created);

    // Reopen so fixture setup cannot leave cached statements outside the observer.
    await closeOpenClawAgentDatabasesAsync();
    closeOpenClawAgentDatabasesForTest();
    const db = openOpenClawAgentDatabase({ agentId: "main" }).db;
    const prepare = db.prepare.bind(db);
    let writes = 0;
    let firedTextBytes = 0;
    const observeRow = (row: Record<string, unknown>) => {
      if (row.status !== "fired") {
        return;
      }
      for (const value of Object.values(row)) {
        if (typeof value === "string") {
          firedTextBytes += Buffer.byteLength(value);
        }
      }
    };
    const prepareSpy = vi.spyOn(db, "prepare").mockImplementation((sql) => {
      const statement = prepare(sql);
      statement.run = new Proxy(statement.run.bind(statement), {
        apply(run, receiver, args) {
          writes += 1;
          return Reflect.apply(run, receiver, args);
        },
      });
      statement.get = new Proxy(statement.get.bind(statement), {
        apply(get, receiver, args) {
          const row = Reflect.apply(get, receiver, args);
          if (row) {
            observeRow(row);
          }
          return row;
        },
      });
      statement.all = new Proxy(statement.all.bind(statement), {
        apply(all, receiver, args) {
          const rows = Reflect.apply(all, receiver, args);
          for (const row of rows) {
            observeRow(row);
          }
          return rows;
        },
      });
      statement.iterate = new Proxy(statement.iterate.bind(statement), {
        apply(iterate, receiver, args) {
          const rows = Reflect.apply(iterate, receiver, args);
          return (function* () {
            for (const row of rows) {
              observeRow(row);
              yield row;
            }
            return undefined;
          })();
        },
      });
      return statement;
    });
    try {
      for (const intent of created) {
        intent.status = "armed";
      }
      expect(
        runSqliteImmediateTransactionSync(db, () =>
          listStandingIntentsInDatabase(db, { nowMs: 62_000 }),
        ),
      ).toEqual(created);
      expect(writes).toBeGreaterThan(0);
      expect(writes).toBeLessThanOrEqual(2);
      expect(firedTextBytes).toBeGreaterThan(0);
      expect(firedTextBytes).toBeLessThanOrEqual(4_096);
    } finally {
      prepareSpy.mockRestore();
    }
    const expectedMatches = created.slice(0, 3);
    for (const intent of expectedMatches) {
      intent.status = "fired";
      intent.fireCount = 2;
      intent.lastFiredAt = 62_001;
    }
    expect(
      await matchStandingIntents({ agentId: "main", prompt: "cohort review", nowMs: 62_001 }),
    ).toEqual(expectedMatches);
  });

  it("keeps provider, conversation, sender, and account identities namespaced", async () => {
    await createStandingIntent({
      agentId: "main",
      description: "Account-scoped reminder.",
      triggerKeywords: ["account reminder"],
      channelScope: encodeStandingIntentChannelScope({
        scope: "conversation",
        provider: "slack",
        accountId: "work",
        conversationId: "slack",
      }),
      senderScope: encodeStandingIntentSenderScope({
        provider: "slack",
        accountId: "work",
        senderId: "alice",
      }),
      maxFires: 1,
      nowMs: 1_000,
    });

    expect(
      await matchStandingIntents({
        agentId: "main",
        prompt: "account reminder",
        channel: "other-room",
        provider: "slack",
        accountId: "work",
        senderId: "alice",
        nowMs: 2_000,
      }),
    ).toHaveLength(0);
    expect(
      await matchStandingIntents({
        agentId: "main",
        prompt: "account reminder",
        channel: "slack",
        provider: "slack",
        accountId: "personal",
        senderId: "alice",
        nowMs: 3_000,
      }),
    ).toHaveLength(0);
    expect(
      await matchStandingIntents({
        agentId: "main",
        prompt: "account reminder",
        channel: "slack",
        provider: "slack",
        accountId: "work",
        senderId: "alice",
        nowMs: 4_000,
      }),
    ).toHaveLength(1);
  });

  it("requires complete trigger phrases and supports one-character keywords", async () => {
    await createStandingIntent({
      agentId: "main",
      description: "Check the candidate owner.",
      triggerKeywords: ["release candidate"],
      maxFires: 1,
      nowMs: 1_000,
    });

    expect(
      await matchStandingIntents({
        agentId: "main",
        prompt: "Please summarize the release notes.",
        nowMs: 2_000,
      }),
    ).toStrictEqual([]);
    expect(
      await matchStandingIntents({
        agentId: "main",
        prompt: "The candidate release is ready.",
        nowMs: 3_000,
      }),
    ).toHaveLength(1);

    await createStandingIntent({
      agentId: "main",
      description: "Handle the X project.",
      triggerKeywords: ["x"],
      maxFires: 1,
      nowMs: 4_000,
    });
    expect(await matchStandingIntents({ agentId: "main", prompt: "X", nowMs: 5_000 })).toHaveLength(
      1,
    );

    await createStandingIntent({
      agentId: "main",
      description: "Keep a multiline trigger intact.",
      triggerKeywords: ["alpha\nbeta"],
      maxFires: 1,
      nowMs: 6_000,
    });
    expect(
      await matchStandingIntents({ agentId: "main", prompt: "alpha only", nowMs: 7_000 }),
    ).toStrictEqual([]);
    expect(
      await matchStandingIntents({ agentId: "main", prompt: "alpha and beta", nowMs: 8_000 }),
    ).toHaveLength(1);
  });

  it("accepts chatId-only interactive contexts", () => {
    expect(
      isEligibleStandingIntentTurn({
        trigger: "user",
        sessionId: "session-1",
        messageProvider: "custom-channel",
        chatId: "room-1",
      }),
    ).toBe(true);
  });

  it("matches late prompt terms in the kernel without stale FTS rows starving an armed intent", async () => {
    for (let index = 0; index < 33; index += 1) {
      const stale = await createStandingIntent({
        agentId: "main",
        description: `Stale deployment intent ${index}.`,
        triggerKeywords: ["deployment"],
        nowMs: index,
      });
      await cancelStandingIntent({ agentId: "main", id: stale.id });
      await createStandingIntent({
        agentId: "main",
        description: `Phrase decoy ${index}.`,
        triggerKeywords: [`deployment decoy${index}`],
        nowMs: index,
      });
    }
    const active = await createStandingIntent({
      agentId: "main",
      description: "Use the current deployment intent.",
      triggerKeywords: ["deployment needle"],
      maxFires: 1,
      nowMs: 100,
    });
    const prefix = Array.from({ length: 40 }, (_, index) => `word${index}`).join(" ");

    // Reopen so cached statements from setup cannot bypass the execution counter.
    await closeOpenClawAgentDatabasesAsync();
    closeOpenClawAgentDatabasesForTest();
    const db = openOpenClawAgentDatabase({ agentId: "main" }).db;
    const prepare = db.prepare.bind(db);
    let reads = 0;
    const prepareSpy = vi.spyOn(db, "prepare").mockImplementation((sql) => {
      const statement = prepare(sql);
      statement.all = new Proxy(statement.all.bind(statement), {
        apply(all, receiver, args) {
          reads += 1;
          return Reflect.apply(all, receiver, args);
        },
      });
      statement.get = new Proxy(statement.get.bind(statement), {
        apply(get, receiver, args) {
          reads += 1;
          return Reflect.apply(get, receiver, args);
        },
      });
      statement.iterate = new Proxy(statement.iterate.bind(statement), {
        apply(iterate, receiver, args) {
          reads += 1;
          return Reflect.apply(iterate, receiver, args);
        },
      });
      return statement;
    });
    try {
      const input = prepareStandingIntentMatch({
        prompt: `${prefix} deployment needle`,
        nowMs: 1_000,
      });
      if (!input) {
        throw new Error("Expected the production preparer to admit the late prompt terms");
      }
      const matches = runSqliteImmediateTransactionSync(db, () =>
        matchStandingIntentsInDatabase(db, input),
      );

      expect(matches.map((intent) => intent.id)).toStrictEqual([active.id]);
      expect(reads).toBeGreaterThan(0);
      expect(reads).toBeLessThanOrEqual(4);
    } finally {
      prepareSpy.mockRestore();
    }
    expect(
      (await listStandingIntents({ agentId: "main", nowMs: 1_000 })).find(
        (intent) => intent.id === active.id,
      ),
    ).toMatchObject({ status: "done", fireCount: 1, lastFiredAt: 1_000 });
  });

  it("does not consume fire budgets for intents that do not fit hidden context", async () => {
    const intents: Awaited<ReturnType<typeof createStandingIntent>>[] = [];
    for (let index = 0; index < 3; index += 1) {
      intents.push(
        await createStandingIntent({
          agentId: "main",
          description: `${String(index)}${"x".repeat(499)}`,
          triggerKeywords: ["bounded trigger"],
          maxFires: 1,
          nowMs: index + 1,
        }),
      );
    }

    const matches = await matchStandingIntents({
      agentId: "main",
      prompt: "bounded trigger",
      nowMs: 10_000,
    });
    const stored = await listStandingIntents({ agentId: "main", nowMs: 10_000 });

    expect(matches).toHaveLength(2);
    expect(buildStandingIntentContext(matches)?.length).toBeLessThanOrEqual(
      INTENT_INJECTION_MAX_CHARS,
    );
    expect(stored.find((intent) => intent.id === intents[2]?.id)).toMatchObject({
      status: "armed",
      fireCount: 0,
    });
  });

  it("uses anti-nagging defaults and bounds hidden injection", async () => {
    const intent = await createStandingIntent({
      agentId: "main",
      description: "x".repeat(500),
      triggerKeywords: ["bounded"],
      nowMs: 1_000,
    });

    expect(intent).toMatchObject({
      cooldownSeconds: DEFAULT_INTENT_COOLDOWN_SECONDS,
      maxFires: DEFAULT_INTENT_MAX_FIRES,
      expiresAt: 1_000 + DEFAULT_INTENT_EXPIRY_MS,
    });
    const context = buildStandingIntentContext([intent, intent, intent, intent]);
    expect(context).toContain("Standing intent (created 1970-01-01):");
    expect(context?.length).toBeLessThanOrEqual(INTENT_INJECTION_MAX_CHARS);
    expect(context?.match(/Standing intent/g)).toHaveLength(2);
  });
});
