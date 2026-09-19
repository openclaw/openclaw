import { ChannelType, type GatewayThreadUpdateDispatchData } from "discord-api-types/v10";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "../internal/discord.js";

const lifecycleMocks = vi.hoisted(() => ({
  closeDiscordThreadSessions: vi.fn(async () => 1),
}));
vi.mock("./thread-session-close.js", () => lifecycleMocks);

import { registerDiscordMonitorListeners } from "./provider.startup.js";

function thread(archived: boolean, id = "thread-42"): GatewayThreadUpdateDispatchData {
  return {
    id,
    type: ChannelType.PublicThread,
    guild_id: "guild-1",
    parent_id: "channel-1",
    owner_id: "user-1",
    name: "support thread",
    last_message_id: null,
    rate_limit_per_user: 0,
    thread_metadata: {
      archived,
      auto_archive_duration: 60,
      archive_timestamp: "2026-08-09T00:00:00.000Z",
      locked: false,
    },
    message_count: 0,
    member_count: 1,
    total_message_sent: 0,
  };
}

function createHarness(accountId = "default") {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(null, { status: 204 }));
  const logger = createSubsystemLogger(`discord/test-rejoin/${accountId}`);
  vi.spyOn(logger, "info").mockImplementation(() => {});
  vi.spyOn(logger, "warn").mockImplementation(() => {});
  vi.spyOn(logger, "error").mockImplementation(() => {});
  const client = new Client(
    {
      baseUrl: "http://localhost",
      clientId: "test-app",
      publicKey: "test-public-key",
      token: "test-token",
      autoDeploy: false,
      requestOptions: { fetch },
      eventQueue: { listenerTimeout: 120_000, slowListenerThreshold: 30_000 },
    },
    {},
  );
  registerDiscordMonitorListeners({
    cfg: {},
    client,
    accountId,
    discordConfig: {},
    runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
    dmEnabled: false,
    groupDmEnabled: false,
    dmPolicy: "disabled",
    groupPolicy: "disabled",
    logger,
    messageHandler: vi.fn(async () => {}),
  });
  const update = (archived = false, id?: string) =>
    client.dispatchGatewayEvent("THREAD_UPDATE", thread(archived, id));
  return { client, fetch, logger, update };
}

const denied = () =>
  new Response(JSON.stringify({ message: "Missing Permissions", code: 50013 }), {
    status: 403,
    headers: { "Content-Type": "application/json" },
  });

describe("Discord thread membership through monitor dispatch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    lifecycleMocks.closeDiscordThreadSessions.mockResolvedValue(1);
  });
  afterEach(() => vi.restoreAllMocks());

  it("joins an active thread via PUT, accepts 204 and deduplicates ordinary updates", async () => {
    const { client, fetch, update } = createHarness();
    await update();
    await client.dispatchGatewayEvent("THREAD_UPDATE", { ...thread(false), name: "renamed" });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(
      "https://discord.com/api/v10/channels/thread-42/thread-members/@me",
      expect.objectContaining({ method: "PUT" }),
    );
    expect(lifecycleMocks.closeDiscordThreadSessions).not.toHaveBeenCalled();
  });

  it("closes archived sessions without attempting to join an archived thread", async () => {
    const { fetch, update } = createHarness();
    await update(true);
    expect(fetch).not.toHaveBeenCalled();
    expect(lifecycleMocks.closeDiscordThreadSessions).toHaveBeenCalledWith({
      cfg: {},
      threadId: "thread-42",
    });
  });

  it("claims before REST so overlapping gateway jobs issue one PUT", async () => {
    const { fetch, update } = createHarness();
    const pending = createDeferred<Response>();
    fetch.mockImplementationOnce(() => pending.promise);
    const first = update();
    try {
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
      await update();
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally {
      pending.resolve(new Response(null, { status: 204 }));
      await first;
    }
  });

  it.each(["archive", "READY"] as const)("rejoins after %s resets the lifecycle", async (reset) => {
    const { client, fetch, update } = createHarness();
    await update();
    if (reset === "archive") {
      await update(true);
    } else {
      await client.dispatchGatewayEvent("READY", {});
    }
    await update();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("logs failed REST and permits retry on the next update", async () => {
    const { fetch, logger, update } = createHarness();
    fetch.mockResolvedValueOnce(denied());
    await update();
    await update();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("Missing Permissions"), {
      threadId: "thread-42",
    });
  });

  it.each(["archive", "READY"] as const)(
    "does not let a stale failure erase the new claim after %s",
    async (reset) => {
      const { client, fetch, update } = createHarness();
      const oldResponse = createDeferred<Response>();
      fetch.mockImplementationOnce(() => oldResponse.promise);
      const oldUpdate = update();
      let newUpdate: Promise<void> | undefined;
      try {
        await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
        if (reset === "archive") {
          await update(true);
        } else {
          await client.dispatchGatewayEvent("READY", {});
        }
        newUpdate = update();
        // Both real queued listener jobs are admitted before the old REST request settles.
        await vi.waitFor(() => expect(client.getRuntimeMetrics().eventQueue?.processing).toBe(2));
        oldResponse.resolve(denied());
        await Promise.all([oldUpdate, newUpdate]);
        await update();
        expect(fetch).toHaveBeenCalledTimes(2);
      } finally {
        oldResponse.resolve(denied());
        await Promise.all([oldUpdate, newUpdate]);
      }
    },
  );

  it("keeps membership claims independent for two account clients", async () => {
    const first = createHarness("account-a");
    const second = createHarness("account-b");
    await first.update();
    await second.update();
    await first.client.dispatchGatewayEvent("READY", {});
    await first.update();
    await second.update();
    expect(first.fetch).toHaveBeenCalledTimes(2);
    expect(second.fetch).toHaveBeenCalledTimes(1);
  });
});
