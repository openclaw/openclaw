import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/account-resolution";
import {
  closeOpenClawStateDatabaseForTest,
  createChannelIngressQueueForTests as createChannelIngressQueue,
  listChannelIngressQueueAccountIdsForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import type { PluginDoctorStateMigrationContext } from "openclaw/plugin-sdk/runtime-doctor-migrations";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterEach, beforeEach, expect, it } from "vitest";
import { stateMigrations } from "./doctor-contract-api.js";
import { createEvent } from "./src/webhook-spool.test-support.js";

const migration = stateMigrations[0]!;
let stateDir: string;

function migrationParams(config: OpenClawConfig = {}) {
  const open = <TPayload, TMetadata = unknown, TCompletedMetadata = unknown>(openOptions?: {
    accountId?: string;
  }) =>
    createChannelIngressQueue<TPayload, TMetadata, TCompletedMetadata>({
      channelId: "line",
      ...openOptions,
      stateDir,
    });
  const context: PluginDoctorStateMigrationContext = {
    openPluginStateKeyedStore: () => {
      throw new Error("the LINE spool migration does not use plugin keyed state");
    },
    channelIngressQueues: [
      {
        channelId: "line",
        openChannelIngressQueueForInspection: open,
        openChannelIngressQueue: open,
        listChannelIngressQueueAccountIds: async () =>
          listChannelIngressQueueAccountIdsForTests({ channelId: "line", stateDir }),
      },
    ],
  };
  return {
    config,
    env: process.env,
    stateDir,
    oauthDir: path.join(stateDir, "oauth"),
    context,
  };
}

async function expectMigration(config: OpenClawConfig, rows: Record<string, string>, note = "") {
  for (const [accountId, webhookEventId] of Object.entries(rows)) {
    const legacySeed = createChannelIngressQueue<{
      version: number;
      destination: string;
      event: ReturnType<typeof createEvent>;
    }>({ channelId: "line", accountId, stateDir });
    await legacySeed.enqueue(
      webhookEventId,
      { version: 1, destination: "destination-1", event: createEvent({ webhookEventId }) },
      { laneKey: "user:user-1" },
    );
  }
  const accounts = Object.keys(rows);
  const params = migrationParams(config);
  expect(await migration.detectLegacyState(params)).toEqual({
    preview: accounts.map(
      (id) => `- LINE pre-drain spool rows (account "${id}"): 1 row(s) -> current ingress format`,
    ),
  });
  expect(await migration.migrateLegacyState(params)).toEqual({
    changes: accounts.map(
      (id) =>
        `Migrated LINE pre-drain spool rows (account "${id}"): 1 queued under the current format, 0 dead-lettered at the identity fence${note}`,
    ),
    warnings: [],
  });
  for (const [accountId, eventId] of Object.entries(rows)) {
    const queue = createChannelIngressQueue({ channelId: "line", accountId, stateDir });
    expect((await queue.listPending({ limit: "all" })).map((record) => record.id)).toEqual([
      `message:message-${eventId}`,
    ]);
  }
  expect(await migration.detectLegacyState(params)).toBeNull();
}

beforeEach(async () => {
  stateDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-line-doctor-")));
});
afterEach(async () => {
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
  await fs.rm(stateDir, { recursive: true, force: true });
});

it("detects nothing on a store without pre-drain rows", async () => {
  expect(await migration.detectLegacyState(migrationParams())).toBeNull();
});

it("detects and migrates pre-drain rows for a configured account", async () => {
  await expectMigration({ channels: { line: { accounts: { work: {} } } } }, { work: "legacy-1" });
});

it("detects and migrates pre-drain rows for a named account removed from config", async () => {
  await expectMigration(
    {},
    { default: "legacy-doctor-kept", retired: "legacy-doctor-retired" },
    " (account not currently configured, so these stay queued until it is restored)",
  );
});

it("fails visibly when the doctor host lacks channel ingress queue access", async () => {
  const params = migrationParams();
  const { channelIngressQueues: _queues, ...context } = params.context;
  await expect(migration.detectLegacyState({ ...params, context })).rejects.toThrow(
    /channel ingress queue access/,
  );
});
