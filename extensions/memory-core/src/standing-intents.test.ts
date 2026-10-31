import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  openNodeSqliteDatabase,
  openOpenClawAgentDatabase,
  resolveOpenClawAgentSqlitePath,
} from "openclaw/plugin-sdk/sqlite-runtime";
import {
  requireNativeSqliteDatabase,
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  params: Partial<Omit<Parameters<typeof createStandingIntentRaw>[0], "creatorSender">>,
) {
  return createStandingIntentRaw({
    agentId: "main",
    description: "Review the release.",
    triggerKeywords: ["release"],
    ...params,
    creatorSender: "owner-sender",
  });
}

const list = (nowMs: number) => listStandingIntents({ agentId: "main", nowMs });
const matchIntent = (params: Omit<Parameters<typeof matchStandingIntents>[0], "agentId">) =>
  matchStandingIntents({ agentId: "main", ...params });
const matchIds = async (params: Parameters<typeof matchIntent>[0]) =>
  (await matchIntent(params)).map((intent) => intent.id);
const database = () =>
  requireNativeSqliteDatabase(openOpenClawAgentDatabase({ agentId: "main" }).db);
async function closeAgents() {
  await closeOpenClawAgentDatabasesAsync();
  closeOpenClawAgentDatabasesForTest();
}
function executor(options: Partial<Parameters<typeof createStandingIntentExecutor>[0]> = {}) {
  return createStandingIntentExecutor({
    agentId: "main",
    provider: "qa-channel",
    senderId: "owner-1",
    ...options,
  });
}
const createArgs = (options: Record<string, unknown> = {}) => ({
  action: "create",
  description: "Review the release.",
  triggerKeywords: ["release"],
  ...options,
});
function intentRow(id: string, createdAt = 1_000, expiresAt = 10_000, maxFires = 1, cooldown = 0) {
  return {
    id,
    description: "Review the release.",
    trigger_keywords: '["release"]',
    trigger_embedding: null,
    channel_scope: null,
    sender_scope: null,
    creator_sender: "owner-sender",
    status: "armed" as const,
    expires_at: expiresAt,
    max_fires: maxFires,
    fire_count: 0,
    cooldown_seconds: cooldown,
    last_fired_at: null,
    created_at: createdAt,
    source_session_id: null,
  };
}
function workerContext(db: ReturnType<typeof database>) {
  const context = {
    database: db,
    refuseCommit: false,
    admit(stage: "transaction" | "commit") {
      if (stage === "commit" && context.refuseCommit) {
        throw new Error("test commit refused");
      }
    },
  };
  return context;
}

function parseToolJson(
  result: Awaited<ReturnType<ReturnType<typeof createStandingIntentExecutor>>>,
) {
  const text = result.content.find((entry) => entry.type === "text")?.text;
  return JSON.parse(text ?? "null") as Record<string, unknown>;
}
const createViaTool = async (
  execute: ReturnType<typeof executor>,
  options: Record<string, unknown> = {},
) => parseToolJson(await execute("create", createArgs(options)));
const createKeywordIntent = (
  keyword: string,
  options: Parameters<typeof createStandingIntent>[0] = {},
) => createStandingIntent({ triggerKeywords: [keyword], ...options });
const expectValue = (result: unknown, value: unknown) => expect(result).toMatchObject({ value });

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
    await closeAgents();
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    vi.unstubAllEnvs();
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  it("maintains lifecycle deadlines across bindings, writes, and rollback", async () => {
    const intent = await createStandingIntent({
      nowMs: 1_000,
      expiresAt: 10_000,
      cooldownSeconds: 1,
      maxFires: 3,
    });
    await closeAgents();
    const context = workerContext(database());
    let worker = bindSqliteWorkerBackend(undefined, context);
    const sweep = (nowMs: number) => worker.execute({ type: "sweep", input: { nowMs } });
    const listAt = (nowMs: number) => worker.execute({ type: "list", input: { nowMs } });
    const create = (input: ReturnType<typeof intentRow>) =>
      worker.execute({ type: "create", input });
    sweep(1_000);
    await worker.close();
    worker = bindSqliteWorkerBackend(undefined, context);
    sweep(1_001);
    const match = prepareStandingIntentMatch({ prompt: "release", nowMs: 2_000 });
    expect(match).toBeDefined();
    expectValue(worker.execute({ type: "match", input: match! }), [
      { id: intent.id, status: "fired", fireCount: 1 },
    ]);
    const expectStatus = (nowMs: number, status: string) =>
      expectValue(listAt(nowMs), [{ id: intent.id, status }]);
    expectStatus(2_999, "fired");
    context.refuseCommit = true;
    expect(() => sweep(3_000)).toThrow("test commit refused");
    context.refuseCommit = false;
    expectStatus(3_000, "armed");
    const row = intentRow("replacement", 11_000, 12_000, 3, 1);
    const preciseExpiry = 1_790_000_000_001;
    create({ ...row, id: "precise-expiry", expires_at: preciseExpiry });
    const expectDeadline = (nowMs: number, nextDueAt: number) =>
      expect(sweep(nowMs)).toMatchObject({ nextDueAt });
    expectDeadline(preciseExpiry - 1, preciseExpiry);
    expectDeadline(preciseExpiry, Infinity);
    create({ ...row, id: "large-expiry", expires_at: 2 ** 60 });
    expect(() => sweep(15_000)).not.toThrow();
    worker.execute({
      type: "create",
      input: { ...row, id: "large-fired-expiry", status: "fired", expires_at: 2 ** 60 },
    });
    expect(() => sweep(15_000)).toThrow();
    await worker.close();
  });
  it("keeps empty matching current after creates, cancellation, and rolled-back expiry", async () => {
    await list(1_000);
    await closeAgents();
    const context = workerContext(database());
    let worker = bindSqliteWorkerBackend(undefined, context);
    const match = (prompt = "release", nowMs = 1_000) =>
      worker.execute({ type: "match", input: prepareStandingIntentMatch({ prompt, nowMs })! });
    const empty = { value: [], nextDueAt: Infinity };
    const row = intentRow("release");
    expect(match()).toEqual(empty);
    await worker.close();
    worker = bindSqliteWorkerBackend(undefined, context);
    try {
      expect(match()).toEqual(empty);
      worker.execute({ type: "create", input: row });
      expect(match("unrelated")).toEqual({ ...empty, nextDueAt: row.expires_at });
      expectValue(match(), [{ id: row.id, status: "done", fireCount: 1 }]);
      worker.execute({ type: "create", input: { ...row, id: "cancelled" } });
      worker.execute({ type: "cancel", input: { id: "cancelled" } });
      expect(match()).toEqual(empty);
      expectValue(worker.execute({ type: "list", input: { status: "cancelled", nowMs: 10_000 } }), [
        { id: "cancelled", status: "cancelled" },
      ]);

      worker.execute({ type: "create", input: { ...row, id: "rollback" } });
      context.refuseCommit = true;
      expect(() => match("release", 10_000)).toThrow("test commit refused");
      context.refuseCommit = false;
      expectValue(match(), [{ id: "rollback", status: "done", fireCount: 1 }]);
    } finally {
      await worker.close();
    }
  });

  it("retains first-use schema after a failed create and retries without duplicate intents", async () => {
    const databasePath = resolveOpenClawAgentSqlitePath({ agentId: "main" });
    const db = database();
    db.exec("DROP TABLE standing_intents; DROP TABLE standing_intents_fts");
    expect(
      db.prepare("SELECT name FROM sqlite_schema WHERE name GLOB '*standing_intents*'").all(),
    ).toEqual([]);
    await closeAgents();

    const create = (maxFires: number, nowMs: number) =>
      createKeywordIntent("migration rehearsal", { maxFires, nowMs });
    await expect(create(0, 1_000)).rejects.toThrow("CHECK constraint failed: max_fires > 0");
    await closeAgents();

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

    const created = await create(1, 2_000);
    expect(await matchIds({ prompt: "migration rehearsal", nowMs: 2_000 })).toEqual([created.id]);
    const stored = await list(2_000);
    expect(stored.map((intent) => intent.id)).toEqual([created.id]);
    expect(stored[0]).toMatchObject({ status: "done", fireCount: 1 });
  });

  it.each([
    ["5", 5],
    [undefined, 3],
  ])("creates an intent with maxFires=%j", async (maxFires, expected) => {
    const execute = executor();
    const result = await createViaTool(execute, { maxFires, cooldownSeconds: "0" });
    const options = { maxFires: expected, cooldownSeconds: 0 };
    expect(result.intent).toMatchObject(options);
    expect(await listStandingIntents({ agentId: "main" })).toMatchObject([options]);
  });

  it("injects owner-created intents and skips rows without a known creator", async () => {
    const execute = executor({ conversationId: "qa-dm-5" });
    const { intent } = await createViaTool(execute, { triggerKeywords: ["owner signal"] });
    const created = intent as { id: string };
    expect(
      await matchIds({
        prompt: "owner signal",
        channel: "qa-dm-5",
        provider: "qa-channel",
        senderId: "owner-1",
        nowMs: Date.now(),
      }),
    ).toEqual([created.id]);

    for (const [kind, creator] of [
      ["missing", null],
      ["unknown", "unknown"],
    ] as const) {
      const untrusted = await createKeywordIntent(`${kind} creator signal`);
      database()
        .prepare("UPDATE standing_intents SET creator_sender = ? WHERE id = ?")
        .run(creator, untrusted.id);
    }

    expect(
      await matchIntent({
        prompt: "missing creator signal and unknown creator signal",
        nowMs: Date.now(),
      }),
    ).toEqual([]);
  });

  it("derives typed conversation, channel, anywhere, sender, and anyone scopes", async () => {
    const execute = executor({
      conversationId: "QA-DM-5",
      provider: "QA-CHANNEL",
      senderId: "alice",
    });
    const conversationResult = await createViaTool(execute, {
      triggerKeywords: ["conversation reminder"],
      scope: "conversation",
      senderScope: "anyone",
    });
    expect(conversationResult).toMatchObject({
      intent: { channelScope: "QA-DM-5", senderScope: null },
      message: expect.stringContaining("Intent is armed for this conversation."),
    });
    expect(
      await matchIntent({
        prompt: "conversation reminder",
        channel: "QA-DM-5",
        provider: "qa-channel",
        senderId: "bob",
      }),
    ).toHaveLength(1);

    const anywhereResult = await createViaTool(execute, {
      triggerKeywords: ["global reminder"],
      scope: "anywhere",
    });
    expect(anywhereResult).toMatchObject({
      intent: { channelScope: null, senderScope: "alice" },
      message: expect.stringContaining("Intent is armed everywhere."),
    });
  });

  it("refuses senderless creation instead of exposing it to unrelated channel users", async () => {
    const execute = createStandingIntentExecutor({ agentId: "main" });

    expect(parseToolJson(await execute("list-empty", { action: "list" }))).toEqual({
      intents: [],
    });
    await expect(createViaTool(execute, { triggerKeywords: ["identity free"] })).rejects.toThrow(
      "authenticated channel and sender identity is unavailable",
    );

    expect(await listStandingIntents({ agentId: "main" })).toEqual([]);
    expect(
      await matchIntent({
        prompt: "identity free",
        provider: "qa-channel",
        channel: "unrelated-room",
        senderId: "unrelated-user",
      }),
    ).toEqual([]);
  });

  it("keeps provider, conversation, sender, and account identities namespaced", async () => {
    const identity = { provider: "slack", accountId: "work", senderId: "alice" };
    await createKeywordIntent("account reminder", {
      channelScope: encodeStandingIntentChannelScope({
        ...identity,
        scope: "conversation",
        conversationId: "slack",
      }),
      senderScope: encodeStandingIntentSenderScope(identity),
      maxFires: 1,
      nowMs: 1_000,
    });

    const accountMatch = (channel: string, accountId: string, nowMs: number) =>
      matchIntent({
        ...identity,
        prompt: "account reminder",
        channel,
        accountId,
        nowMs,
      });
    expect(await accountMatch("other-room", "work", 2_000)).toHaveLength(0);
    expect(await accountMatch("slack", "personal", 3_000)).toHaveLength(0);
    expect(await accountMatch("slack", "work", 4_000)).toHaveLength(1);
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

  it("matches late prompt terms without stale FTS rows starving an armed intent", async () => {
    for (let index = 0; index < 33; index += 1) {
      const stale = await createKeywordIntent("deployment", { nowMs: index });
      await cancelStandingIntent({ agentId: "main", id: stale.id });
      await createKeywordIntent(`deployment decoy${index}`, { nowMs: index });
    }
    const active = await createKeywordIntent("deployment needle", { maxFires: 1, nowMs: 100 });
    const prefix = Array.from({ length: 40 }, (_, index) => `word${index}`).join(" ");

    expect(await matchIds({ prompt: `${prefix} deployment needle`, nowMs: 1_000 })).toStrictEqual([
      active.id,
    ]);
    expect((await list(1_000)).find((intent) => intent.id === active.id)).toMatchObject({
      status: "done",
      fireCount: 1,
      lastFiredAt: 1_000,
    });
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
    const intent = await createKeywordIntent("bounded", {
      description: "x".repeat(500),
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
