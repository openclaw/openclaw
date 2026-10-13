import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { describe, expect, it, vi } from "vitest";
import { parseInstallArgs } from "./manager-bot.js";
import { startProvisioning } from "./provisioning-orchestrator.js";
import type { OrchestratorDeps } from "./provisioning-orchestrator.js";
import { ProvisioningStore, type ProvisioningRecord } from "./provisioning-store.js";

// In-memory fake for the keyed store: the real SQLite broker is owned and
// tested by plugin-state; here we prove orchestrator + record logic.
function testStore() {
  const data = new Map<string, ProvisioningRecord>();
  const keyed = {
    lookup: async (key: string) => data.get(key),
    register: async (key: string, value: ProvisioningRecord) => {
      data.set(key, value);
    },
  } as unknown as PluginStateKeyedStore<ProvisioningRecord>;
  return new ProvisioningStore(keyed);
}

function fakeDeps(
  store: ProvisioningStore,
  overrides?: Partial<OrchestratorDeps>,
): OrchestratorDeps {
  return {
    store,
    botCreator: {
      checkUsername: async () => true,
      createBot: async ({ username }) => ({ botId: `bot-${username}` }),
    },
    tokenExporter: {
      exportBotToken: async ({ botId }) => ({ token: `1:${botId}` }),
    },
    hetzner: {
      createServer: async () => ({
        id: 42,
        name: "openclaw-x",
        status: "starting",
        publicIpv4: "9.9.9.9",
      }),
      getServer: async () => ({
        id: 42,
        name: "openclaw-x",
        status: "running",
        publicIpv4: "9.9.9.9",
      }),
    },
    healthProbe: async () => 200,
    config: {
      serverType: "cx23",
      location: "nbg1",
      image: "debian-12",
      sshKeyNames: [],
      openclawImage: "ghcr.io/openclaw/openclaw:latest",
    },
    notify: () => undefined,
    ...overrides,
  };
}

async function waitFor(
  store: ProvisioningStore,
  user: string,
  terminal: boolean,
  timeoutMs = 5_000,
) {
  const start = Date.now();
  for (;;) {
    const r = await store.load(user);
    if (r && (terminal ? r.state === "READY" || r.state === "FAILED" : true)) {
      return r;
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error("timed out waiting for provisioning");
    }
    await new Promise<void>((resolve) => {
      setTimeout(() => {
        resolve();
      }, 25);
    });
  }
}

describe("provisioning orchestrator", () => {
  it("drives the full 9-state flow to READY", async () => {
    const store = testStore();
    await startProvisioning(fakeDeps(store), {
      telegramUserId: "111",
      botName: "B",
      botUsername: "b1_bot",
    });
    const final = await waitFor(store, "111", true);
    expect(final?.state).toBe("READY");
    expect(final?.history.map((h) => h.state)).toEqual([
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
    expect(final?.serverIp).toBe("9.9.9.9");
  });

  it("lands in FAILED with the error persisted when bot creation fails", async () => {
    const store = testStore();
    const notify = vi.fn();
    await startProvisioning(
      fakeDeps(store, {
        notify,
        botCreator: {
          checkUsername: async () => true,
          createBot: async () => {
            throw new Error("USERNAME_OCCUPIED");
          },
        },
      }),
      { telegramUserId: "222", botName: "B", botUsername: "taken_bot" },
    );
    const final = await waitFor(store, "222", true);
    expect(final?.state).toBe("FAILED");
    expect(final?.error).toContain("USERNAME_OCCUPIED");
    expect(notify).toHaveBeenCalled();
  });

  it("isolates multiple users end-to-end", async () => {
    const store = testStore();
    const deps = fakeDeps(store);
    await startProvisioning(deps, { telegramUserId: "u1", botName: "A", botUsername: "a1_bot" });
    await startProvisioning(deps, { telegramUserId: "u2", botName: "B", botUsername: "b2_bot" });
    const [r1, r2] = await Promise.all([waitFor(store, "u1", true), waitFor(store, "u2", true)]);
    expect(r1?.state).toBe("READY");
    expect(r2?.state).toBe("READY");
    expect(r1?.botUsername).toBe("a1_bot");
    expect(r2?.botUsername).toBe("b2_bot");
    expect(r1?.installationId).not.toBe(r2?.installationId);
  });

  it("rejects concurrent installs for the same user", async () => {
    const store = testStore();
    const slow = fakeDeps(store, {
      healthProbe: async () => {
        await new Promise<void>((resolve) => {
          setTimeout(() => {
            resolve();
          }, 200);
        });
        return 200;
      },
    });
    await startProvisioning(slow, { telegramUserId: "dup", botName: "A", botUsername: "dup_bot" });
    await expect(
      startProvisioning(slow, { telegramUserId: "dup", botName: "A", botUsername: "dup_bot" }),
    ).rejects.toThrow("already in progress");
    await waitFor(store, "dup", true, 10_000);
  });
});

describe("manager bot /install parsing", () => {
  it("parses bare username and name|username forms", () => {
    expect(parseInstallArgs("/install mybot_bot")).toMatchObject({ botUsername: "mybot_bot" });
    expect(parseInstallArgs("/install My Bot|mybot_bot")).toMatchObject({
      botName: "My Bot",
      botUsername: "mybot_bot",
    });
    expect(parseInstallArgs("/install")).toMatchObject({ error: expect.any(String) });
    expect(parseInstallArgs("/install notauser")).toMatchObject({ error: expect.any(String) });
  });
});
