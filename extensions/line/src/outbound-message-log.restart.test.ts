// Line tests cover the record of sent message ids surviving a Gateway restart.
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import type { OpenKeyedStoreOptions } from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it } from "vitest";
import { setLineRuntime } from "./runtime.js";

// A gateway restart or config reload drops module state; only the plugin state
// database survives. Each "start" re-imports the log against the same state dir.
describe("outbound message log across restarts", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  let starts = 0;

  // A query suffix loads a fresh copy of the log, so its in-memory ids are gone
  // while the shared runtime and state database modules stay the same.
  async function startLine(stateDir: string, bots: Record<string, string>) {
    const runtime = createPluginRuntimeMock();
    runtime.state.openKeyedStore = ((options: OpenKeyedStoreOptions) =>
      createPluginStateKeyedStoreForTests("line", {
        ...options,
        env: { OPENCLAW_STATE_DIR: stateDir },
      })) as typeof runtime.state.openKeyedStore;
    setLineRuntime(runtime);
    starts += 1;
    const freshLog = `./outbound-message-log.js?start=${starts}`;
    const log = (await import(freshLog)) as typeof import("./outbound-message-log.js");
    // What the startup bot info probe reports for each account.
    for (const [accountId, botUserId] of Object.entries(bots)) {
      log.rememberLineBotUserId(accountId, botUserId);
    }
    return log;
  }

  async function stopLine() {
    await closeOpenClawStateDatabaseAsync();
    resetPluginStateStoreForTests();
  }

  afterEach(async () => {
    await stopLine();
  });

  it("still treats a quote of a message sent before the restart as addressing the bot", async () => {
    const stateDir = tempDirs.make("line-sent-messages-");
    const before = await startLine(stateDir, { default: "U-bot-a", other: "U-bot-b" });
    await before.recordLineSentMessages("default", ["sent-before-restart"]);
    await stopLine();

    const after = await startLine(stateDir, { default: "U-bot-a", other: "U-bot-b" });
    const quotes = (accountId: string, botUserId: string, quotedMessageId: string) =>
      after.quotesLineBotMessage({ accountId, botUserId, quotedMessageId });

    expect(await quotes("default", "U-bot-a", "sent-before-restart")).toBe(true);
    expect(await quotes("default", "U-bot-a", "never-sent")).toBe(false);
    expect(await quotes("other", "U-bot-b", "sent-before-restart")).toBe(false);
  });

  it("does not let an account re-pointed at another bot inherit the previous bot's messages", async () => {
    const stateDir = tempDirs.make("line-sent-messages-");
    const before = await startLine(stateDir, { default: "U-bot-a" });
    await before.recordLineSentMessages("default", ["sent-by-bot-a"]);
    await stopLine();

    // Same config account name, new LINE channel.
    const after = await startLine(stateDir, { default: "U-bot-c" });
    await after.recordLineSentMessages("default", ["sent-by-bot-c"]);

    expect(
      await after.quotesLineBotMessage({
        accountId: "default",
        botUserId: "U-bot-c",
        quotedMessageId: "sent-by-bot-a",
      }),
    ).toBe(false);
    await stopLine();

    const later = await startLine(stateDir, { default: "U-bot-c" });
    expect(
      await later.quotesLineBotMessage({
        accountId: "default",
        botUserId: "U-bot-c",
        quotedMessageId: "sent-by-bot-c",
      }),
    ).toBe(true);
  });

  // The durable webhook queue can replay an event received before the restart,
  // still naming the previous bot as its destination.
  it("does not let a recovered quote for the previous bot address the re-pointed account", async () => {
    const stateDir = tempDirs.make("line-sent-messages-");
    const before = await startLine(stateDir, { default: "U-bot-a" });
    await before.recordLineSentMessages("default", ["sent-by-bot-a"]);
    await stopLine();

    const repointed = await startLine(stateDir, { default: "U-bot-b" });
    expect(
      await repointed.quotesLineBotMessage({
        accountId: "default",
        botUserId: "U-bot-a",
        quotedMessageId: "sent-by-bot-a",
      }),
    ).toBe(false);
    await stopLine();

    // Without a known current bot, nothing persisted is consulted either.
    const unknown = await startLine(stateDir, {});
    expect(
      await unknown.quotesLineBotMessage({
        accountId: "default",
        botUserId: "U-bot-a",
        quotedMessageId: "sent-by-bot-a",
      }),
    ).toBe(false);
  });

  it("stays memory-only while the bot's user id is unknown", async () => {
    const stateDir = tempDirs.make("line-sent-messages-");
    const before = await startLine(stateDir, {});
    await before.recordLineSentMessages("default", ["sent-while-unknown"]);

    expect(
      await before.quotesLineBotMessage({
        accountId: "default",
        botUserId: undefined,
        quotedMessageId: "sent-while-unknown",
      }),
    ).toBe(true);
    await stopLine();

    const after = await startLine(stateDir, { default: "U-bot-a" });
    expect(
      await after.quotesLineBotMessage({
        accountId: "default",
        botUserId: "U-bot-a",
        quotedMessageId: "sent-while-unknown",
      }),
    ).toBe(false);
  });

  it("keeps the newest 500 ids per bot and drops older ones first", async () => {
    const stateDir = tempDirs.make("line-sent-messages-");
    const bots = { quiet: "U-bot-quiet", busy: "U-bot-busy" };
    const before = await startLine(stateDir, bots);
    await before.recordLineSentMessages("quiet", ["quiet-1"]);
    await before.recordLineSentMessages(
      "busy",
      Array.from({ length: 501 }, (_, index) => `busy-${index}`),
    );
    await stopLine();

    const after = await startLine(stateDir, bots);
    const busy = (quotedMessageId: string) =>
      after.quotesLineBotMessage({ accountId: "busy", botUserId: bots.busy, quotedMessageId });

    expect(await busy("busy-0")).toBe(false);
    expect(await busy("busy-1")).toBe(true);
    expect(await busy("busy-500")).toBe(true);
    expect(
      await after.quotesLineBotMessage({
        accountId: "quiet",
        botUserId: bots.quiet,
        quotedMessageId: "quiet-1",
      }),
    ).toBe(true);
  });

  // Released versions never write LINE sent-message state, so an upgraded state
  // database holds only other owners' rows. The new namespace must start empty and
  // leave those rows untouched.
  it("starts empty on an existing state database and leaves its rows intact", async () => {
    const stateDir = tempDirs.make("line-sent-messages-");
    const existing = createPluginStateKeyedStoreForTests<{ chatId: string }>("telegram", {
      namespace: "telegram.sent-messages",
      maxEntries: 10,
      env: { OPENCLAW_STATE_DIR: stateDir },
    });
    await existing.register("existing-row", { chatId: "chat-1" });
    await stopLine();

    const upgraded = await startLine(stateDir, { default: "U-bot-a" });
    expect(
      await upgraded.quotesLineBotMessage({
        accountId: "default",
        botUserId: "U-bot-a",
        quotedMessageId: "existing-row",
      }),
    ).toBe(false);
    await upgraded.recordLineSentMessages("default", ["sent-after-upgrade"]);
    await stopLine();

    const after = await startLine(stateDir, { default: "U-bot-a" });
    expect(
      await after.quotesLineBotMessage({
        accountId: "default",
        botUserId: "U-bot-a",
        quotedMessageId: "sent-after-upgrade",
      }),
    ).toBe(true);
    const reopened = createPluginStateKeyedStoreForTests<{ chatId: string }>("telegram", {
      namespace: "telegram.sent-messages",
      maxEntries: 10,
      env: { OPENCLAW_STATE_DIR: stateDir },
    });
    expect(await reopened.lookup("existing-row")).toEqual({ chatId: "chat-1" });
  });
});
