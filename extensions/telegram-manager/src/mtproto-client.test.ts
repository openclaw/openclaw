import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { describe, expect, it } from "vitest";
import { createMtprotoBotCreator, createMtprotoTokenExporter } from "./mtproto-client.js";
import { ONBOARDING_STEPS } from "./onboarding-flow.js";
import { ProvisioningStore, type ProvisioningRecord } from "./provisioning-store.js";
import { UserSessionTracker } from "./user-session.js";

describe("mtproto client adapters", () => {
  it("maps check/create/export onto raw invoke methods", async () => {
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    const invoke = async (method: string, params: Record<string, unknown>) => {
      calls.push({ method, params });
      if (method === "bots.checkUsername") {
        return { available: true };
      }
      if (method === "bots.createBot") {
        return { botId: "123" };
      }
      return { token: "123:ABC" };
    };
    const creator = createMtprotoBotCreator(invoke);
    const exporter = createMtprotoTokenExporter(invoke);
    await expect(creator.checkUsername("mybot_bot")).resolves.toBe(true);
    await expect(creator.createBot({ name: "B", username: "mybot_bot" })).resolves.toEqual({
      botId: "123",
    });
    await expect(exporter.exportBotToken({ botId: "123", revoke: false })).resolves.toEqual({
      token: "123:ABC",
    });
    expect(calls.map((c) => c.method)).toEqual([
      "bots.checkUsername",
      "bots.createBot",
      "bots.exportBotToken",
    ]);
  });

  it("rejects empty create/export responses", async () => {
    const creator = createMtprotoBotCreator(async () => ({}));
    await expect(creator.createBot({ name: "B", username: "x_bot" })).rejects.toThrow(
      "BOT_INVALID",
    );
    const exporter = createMtprotoTokenExporter(async () => ({}));
    await expect(exporter.exportBotToken({ botId: "1", revoke: false })).rejects.toThrow(
      "BOT_INVALID",
    );
  });
});

describe("onboarding flow + user sessions", () => {
  it("exposes the linear step order", () => {
    expect([...ONBOARDING_STEPS]).toEqual([
      "REQUESTED",
      "CREATING_BOT",
      "BOT_CREATED",
      "CREATING_SERVER",
      "SERVER_CREATED",
      "INSTALLING_OPENCLAW",
      "CONFIGURING_OPENCLAW",
      "VERIFYING",
      "READY",
    ]);
  });

  it("tracks active vs terminal sessions", async () => {
    const data = new Map<string, ProvisioningRecord>();
    const keyed = {
      lookup: async (key: string) => data.get(key),
      register: async (key: string, value: ProvisioningRecord) => {
        data.set(key, value);
      },
    } as unknown as PluginStateKeyedStore<ProvisioningRecord>;
    const store = new ProvisioningStore(keyed);
    const tracker = new UserSessionTracker(store);
    await expect(tracker.get("ghost")).resolves.toBeUndefined();
    await expect(tracker.isActive("ghost")).resolves.toBe(false);
    const now = new Date().toISOString();
    await store.save({
      version: 1,
      installationId: "i1",
      telegramUserId: "u1",
      state: "CREATING_BOT",
      createdAt: now,
      updatedAt: now,
      history: [{ state: "REQUESTED", at: now }],
    });
    await expect(tracker.isActive("u1")).resolves.toBe(true);
    await expect(tracker.get("u1")).resolves.toMatchObject({
      telegramUserId: "u1",
      state: "CREATING_BOT",
    });
  });
});
