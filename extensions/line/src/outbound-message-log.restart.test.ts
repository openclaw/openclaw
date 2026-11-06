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
  // while the shared runtime and state database modules stay the same. `bots` is
  // what the startup bot info probe reports for each account.
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
    for (const [accountId, botUserId] of Object.entries(bots)) {
      log.rememberLineBotUserId(accountId, botUserId);
    }
    return {
      record: log.recordLineSentMessages,
      // The webhook destination defaults to the bot the account speaks for.
      quotes: (accountId: string, quotedMessageId: string, botUserId = bots[accountId]) =>
        log.quotesLineBotMessage({ accountId, botUserId, quotedMessageId }),
    };
  }

  async function stopLine() {
    await closeOpenClawStateDatabaseAsync();
    resetPluginStateStoreForTests();
  }

  afterEach(stopLine);

  it("still treats a quote of a message sent before the restart as addressing the bot", async () => {
    const stateDir = tempDirs.make("line-sent-messages-");
    const bots = { default: "U-bot-a", other: "U-bot-b" };
    await (await startLine(stateDir, bots)).record("default", ["sent-before-restart"]);
    await stopLine();

    const after = await startLine(stateDir, bots);
    expect(await after.quotes("default", "sent-before-restart")).toBe(true);
    expect(await after.quotes("default", "never-sent")).toBe(false);
    expect(await after.quotes("other", "sent-before-restart")).toBe(false);
  });

  it("does not let an account re-pointed at another bot inherit the previous bot's messages", async () => {
    const stateDir = tempDirs.make("line-sent-messages-");
    await (await startLine(stateDir, { default: "U-bot-a" })).record("default", ["sent-by-a"]);
    await stopLine();

    // Same config account name, new LINE channel.
    const repointed = await startLine(stateDir, { default: "U-bot-c" });
    await repointed.record("default", ["sent-by-c"]);
    expect(await repointed.quotes("default", "sent-by-a")).toBe(false);
    // The durable webhook queue can replay an event received before the restart,
    // still naming the previous bot as its destination.
    expect(await repointed.quotes("default", "sent-by-a", "U-bot-a")).toBe(false);
    await stopLine();

    const later = await startLine(stateDir, { default: "U-bot-c" });
    expect(await later.quotes("default", "sent-by-c")).toBe(true);
    await stopLine();
    // Without a known current bot, nothing persisted is consulted either.
    const unknown = await startLine(stateDir, {});
    expect(await unknown.quotes("default", "sent-by-c", "U-bot-c")).toBe(false);
  });

  it("stays memory-only while the bot's user id is unknown", async () => {
    const stateDir = tempDirs.make("line-sent-messages-");
    const before = await startLine(stateDir, {});
    await before.record("default", ["sent-while-unknown"]);
    expect(await before.quotes("default", "sent-while-unknown")).toBe(true);
    await stopLine();

    const after = await startLine(stateDir, { default: "U-bot-a" });
    expect(await after.quotes("default", "sent-while-unknown")).toBe(false);
  });

  it("keeps the newest 500 ids per bot and drops older ones first", async () => {
    const stateDir = tempDirs.make("line-sent-messages-");
    const bots = { quiet: "U-bot-quiet", busy: "U-bot-busy" };
    const before = await startLine(stateDir, bots);
    await before.record("quiet", ["quiet-1"]);
    await before.record(
      "busy",
      Array.from({ length: 501 }, (_, index) => `busy-${index}`),
    );
    await stopLine();

    const after = await startLine(stateDir, bots);
    expect(await after.quotes("busy", "busy-0")).toBe(false);
    expect(await after.quotes("busy", "busy-1")).toBe(true);
    expect(await after.quotes("busy", "busy-500")).toBe(true);
    expect(await after.quotes("quiet", "quiet-1")).toBe(true);
  });

  // Released versions never write LINE sent-message state, so an upgraded state
  // database holds only other owners' rows. The new namespace must start empty and
  // leave those rows untouched.
  it("starts empty on an existing state database and leaves its rows intact", async () => {
    const stateDir = tempDirs.make("line-sent-messages-");
    const telegramSent = () =>
      createPluginStateKeyedStoreForTests<{ chatId: string }>("telegram", {
        namespace: "telegram.sent-messages",
        maxEntries: 10,
        env: { OPENCLAW_STATE_DIR: stateDir },
      });
    await telegramSent().register("existing-row", { chatId: "chat-1" });
    await stopLine();

    const upgraded = await startLine(stateDir, { default: "U-bot-a" });
    expect(await upgraded.quotes("default", "existing-row")).toBe(false);
    await upgraded.record("default", ["sent-after-upgrade"]);
    await stopLine();

    const after = await startLine(stateDir, { default: "U-bot-a" });
    expect(await after.quotes("default", "sent-after-upgrade")).toBe(true);
    expect(await telegramSent().lookup("existing-row")).toEqual({ chatId: "chat-1" });
  });
});
