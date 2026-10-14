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
  observeHostDataSql,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { matchStandingIntentsInDatabase } from "./standing-intents-kernel.js";
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
} from "./standing-intents.js";
import { bindSqliteWorkerBackend } from "./standing-intents.worker.js";

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

  it("reuses lifecycle deadlines across bindings and invalidates them on writes and rollback", async () => {
    const intent = await createStandingIntent({
      agentId: "main",
      description: "Review the release.",
      triggerKeywords: ["release"],
      nowMs: 1_000,
      expiresAt: 10_000,
      cooldownSeconds: 1,
      maxFires: 3,
    });
    await closeOpenClawAgentDatabasesAsync();
    closeOpenClawAgentDatabasesForTest();
    const db = openOpenClawAgentDatabase({ agentId: "main" }).db;
    let refuseCommit = false;
    const context = {
      database: db,
      admit(stage: "transaction" | "commit") {
        if (stage === "commit" && refuseCommit) {
          throw new Error("test commit refused");
        }
      },
    };
    let worker = bindSqliteWorkerBackend(undefined, context);
    worker.execute({ type: "sweep", input: { nowMs: 1_000 } });
    await worker.close();
    worker = bindSqliteWorkerBackend(undefined, context);
    const sql = observeHostDataSql();
    try {
      worker.execute({ type: "sweep", input: { nowMs: 1_001 } });
      expect(sql.queries.filter((query) => query.includes('"standing_intents"'))).toEqual([]);
    } finally {
      sql.restore();
    }
    const match = prepareStandingIntentMatch({ prompt: "release", nowMs: 2_000 });
    expect(match).toBeDefined();
    expect(worker.execute({ type: "match", input: match! })).toMatchObject({
      kind: "result",
      value: [{ id: intent.id, status: "fired", fireCount: 1 }],
    });
    expect(worker.execute({ type: "list", input: { nowMs: 2_999 } })).toMatchObject({
      kind: "result",
      value: [{ id: intent.id, status: "fired" }],
    });
    refuseCommit = true;
    expect(() => worker.execute({ type: "sweep", input: { nowMs: 3_000 } })).toThrow(
      "test commit refused",
    );
    refuseCommit = false;
    expect(worker.execute({ type: "list", input: { nowMs: 3_000 } })).toMatchObject({
      kind: "result",
      value: [{ id: intent.id, status: "armed" }],
    });
    expect(worker.execute({ type: "list", input: { nowMs: 10_000 } })).toMatchObject({
      kind: "result",
      value: [{ id: intent.id, status: "expired" }],
    });
    const row = {
      id: "replacement",
      description: "Review another release.",
      trigger_keywords: '["release"]',
      trigger_embedding: null,
      channel_scope: null,
      sender_scope: null,
      creator_sender: "owner-sender",
      status: "armed" as const,
      expires_at: 12_000,
      max_fires: 3,
      fire_count: 0,
      cooldown_seconds: 1,
      last_fired_at: null,
      created_at: 11_000,
      source_session_id: null,
    };
    worker.execute({ type: "create", input: row });
    expect(worker.execute({ type: "list", input: { nowMs: 12_000 } })).toMatchObject({
      kind: "result",
      value: [
        { id: intent.id, status: "expired" },
        { id: row.id, status: "expired" },
      ],
    });
    worker.execute({ type: "create", input: { ...row, id: "cancelled", expires_at: 14_000 } });
    worker.execute({ type: "cancel", input: { id: "cancelled" } });
    expect(
      worker.execute({ type: "list", input: { status: "cancelled", nowMs: 14_000 } }),
    ).toMatchObject({
      kind: "result",
      value: [{ id: "cancelled", status: "cancelled" }],
    });
    const preciseExpiry = 1_790_000_000_001;
    worker.execute({
      type: "create",
      input: { ...row, id: "precise-expiry", expires_at: preciseExpiry },
    });
    expect(worker.execute({ type: "sweep", input: { nowMs: preciseExpiry - 1 } })).toMatchObject({
      nextDueAt: preciseExpiry,
    });
    expect(worker.execute({ type: "sweep", input: { nowMs: preciseExpiry } })).toMatchObject({
      nextDueAt: Infinity,
    });
    worker.execute({ type: "create", input: { ...row, id: "large-expiry", expires_at: 2 ** 60 } });
    expect(() => worker.execute({ type: "sweep", input: { nowMs: 15_000 } })).not.toThrow();
    worker.execute({
      type: "create",
      input: { ...row, id: "large-fired-expiry", status: "fired", expires_at: 2 ** 60 },
    });
    expect(() => worker.execute({ type: "sweep", input: { nowMs: 15_000 } })).toThrow();
    await worker.close();
  });
  it("skips empty match transactions without hiding creates, cancellation, or rolled-back expiry", async () => {
    await listStandingIntents({ agentId: "main", nowMs: 1_000 });
    await closeOpenClawAgentDatabasesAsync();
    closeOpenClawAgentDatabasesForTest();
    const db = openOpenClawAgentDatabase({ agentId: "main" }).db;
    let refuseCommit = false;
    const context = {
      database: db,
      admit(stage: "transaction" | "commit") {
        if (stage === "commit" && refuseCommit) {
          throw new Error("test commit refused");
        }
      },
    };
    let worker = bindSqliteWorkerBackend(undefined, context);
    const match = (prompt = "release", nowMs = 1_000) =>
      worker.execute({ type: "match", input: prepareStandingIntentMatch({ prompt, nowMs })! });
    const empty = { kind: "result", value: [], nextDueAt: Infinity };
    const row = {
      id: "release",
      description: "Review the release.",
      trigger_keywords: '["release"]',
      trigger_embedding: null,
      channel_scope: null,
      sender_scope: null,
      creator_sender: "owner-sender",
      status: "armed" as const,
      expires_at: 10_000,
      max_fires: 1,
      fire_count: 0,
      cooldown_seconds: 0,
      last_fired_at: null,
      created_at: 1_000,
      source_session_id: null,
    };
    expect(match()).toEqual(empty);
    await worker.close();
    worker = bindSqliteWorkerBackend(undefined, context);
    const observation = observeHostDataSql();
    try {
      expect(match()).toEqual(empty);
      expect(observation.queries).toEqual([]);
      worker.execute({ type: "create", input: row });
      expect(match("unrelated")).toEqual({ ...empty, nextDueAt: row.expires_at });
      expect(match()).toMatchObject({
        kind: "result",
        value: [{ id: row.id, status: "done", fireCount: 1 }],
      });
      worker.execute({ type: "create", input: { ...row, id: "cancelled" } });
      worker.execute({ type: "cancel", input: { id: "cancelled" } });
      expect(match()).toEqual(empty);
      const reads = observation.queries.length;
      expect(match()).toEqual(empty);
      expect(observation.queries).toHaveLength(reads);

      worker.execute({ type: "create", input: { ...row, id: "rollback" } });
      refuseCommit = true;
      expect(() => match("release", 10_000)).toThrow("test commit refused");
      refuseCommit = false;
      expect(match()).toMatchObject({
        kind: "result",
        value: [{ id: "rollback", status: "done", fireCount: 1 }],
      });
    } finally {
      observation.restore();
      await worker.close();
    }
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
