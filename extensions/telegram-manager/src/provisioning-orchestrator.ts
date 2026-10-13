// Orchestrator: drives REQUESTED → … → READY/FAILED with injected side effects.
// All persistence goes through ProvisioningStore (plugin_state_entries).
import { randomUUID } from "node:crypto";
import type { HetznerClient } from "./hetzner-client.js";
import { createManagedBotWithToken } from "./mtproto-managed-bots.js";
import { buildOpenClawUserData, isGatewayHealthyStatus } from "./openclaw-installer.js";
import { assertTransition, type ProvisioningState } from "./provisioning-states.js";
import type { ProvisioningRecord, ProvisioningStore } from "./provisioning-store.js";

export type OrchestratorDeps = {
  store: ProvisioningStore;
  botCreator: Parameters<typeof createManagedBotWithToken>[0]["creator"];
  tokenExporter: Parameters<typeof createManagedBotWithToken>[0]["exporter"];
  hetzner: Pick<HetznerClient, "createServer" | "getServer">;
  healthProbe: (host: string) => Promise<number>;
  config: {
    serverType: string;
    location: string;
    image: string;
    sshKeyNames: string[];
    openclawImage: string;
  };
  notify: (telegramUserId: string, text: string) => Promise<void> | void;
};

function recordTransition(record: ProvisioningRecord, to: ProvisioningState, error?: string): void {
  assertTransition(record.state, to);
  record.state = to;
  const entry: ProvisioningRecord["history"][number] = { state: to, at: new Date().toISOString() };
  if (error) {
    entry.error = error;
  }
  record.history.push(entry);
  if (error) {
    record.error = error;
  } else if (to !== "FAILED") {
    record.error = undefined;
  }
  record.updatedAt = new Date().toISOString();
}

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      resolve();
    }, ms);
    timer.unref?.();
  });
}

export async function startProvisioning(
  deps: OrchestratorDeps,
  params: { telegramUserId: string; botName: string; botUsername: string },
): Promise<ProvisioningRecord> {
  const existing = await deps.store.load(params.telegramUserId);
  if (existing && existing.state !== "READY" && existing.state !== "FAILED") {
    throw new Error(`Provisioning already in progress (${existing.state})`);
  }
  const now = new Date().toISOString();
  const record: ProvisioningRecord = {
    version: 1,
    installationId: randomUUID(),
    telegramUserId: params.telegramUserId,
    state: "REQUESTED",
    botUsername: params.botUsername,
    createdAt: now,
    updatedAt: now,
    history: [{ state: "REQUESTED", at: now }],
  };
  await deps.store.save(record);
  // Fire-and-forget drive; failures land in FAILED with error persisted.
  void driveToCompletion(deps, params.telegramUserId, params).catch(() => undefined);
  return record;
}

async function driveToCompletion(
  deps: OrchestratorDeps,
  telegramUserId: string,
  input: { botName: string; botUsername: string },
): Promise<void> {
  const fail = async (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    await deps.store.update(telegramUserId, (current) => {
      if (!current) {
        throw new Error("missing provisioning record");
      }
      recordTransition(current, "FAILED", message.slice(0, 500));
      return current;
    });
    await deps.notify(telegramUserId, `❌ Provisioning failed: ${message.slice(0, 300)}`);
  };

  try {
    // CREATING_BOT → BOT_CREATED (MTProto managed bots).
    await deps.store.update(telegramUserId, (c) => {
      if (!c) {
        throw new Error("missing record");
      }
      recordTransition(c, "CREATING_BOT");
      return c;
    });
    const { botId, token } = await createManagedBotWithToken({
      creator: deps.botCreator,
      exporter: deps.tokenExporter,
      name: input.botName,
      username: input.botUsername,
    });
    await deps.store.update(telegramUserId, (c) => {
      if (!c) {
        throw new Error("missing record");
      }
      c.botId = botId;
      recordTransition(c, "BOT_CREATED");
      return c;
    });
    await deps.notify(telegramUserId, `🤖 Bot @${input.botUsername} created. Provisioning server…`);

    // CREATING_SERVER → SERVER_CREATED (Hetzner).
    await deps.store.update(telegramUserId, (c) => {
      if (!c) {
        throw new Error("missing record");
      }
      recordTransition(c, "CREATING_SERVER");
      return c;
    });
    const gatewayToken = randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "");
    const userData = buildOpenClawUserData({
      botToken: token,
      gatewayToken,
      image: deps.config.openclawImage,
      telegramAllowFrom: [telegramUserId],
    });
    const server = await deps.hetzner.createServer({
      name: `openclaw-${
        telegramUserId
          .toLowerCase()
          .replace(/[^a-z0-9-]/g, "")
          .slice(0, 32) || "user"
      }`,
      serverType: deps.config.serverType,
      location: deps.config.location,
      image: deps.config.image,
      sshKeys: deps.config.sshKeyNames,
      userData,
    });
    await deps.store.update(telegramUserId, (c) => {
      if (!c) {
        throw new Error("missing record");
      }
      c.serverId = server.id;
      c.serverIp = server.publicIpv4;
      recordTransition(c, "SERVER_CREATED");
      return c;
    });

    // INSTALLING → CONFIGURING: user_data runs setup.sh on first boot.
    // We poll getServer until running, then treat cloud-init as installing.
    await deps.store.update(telegramUserId, (c) => {
      if (!c) {
        throw new Error("missing record");
      }
      recordTransition(c, "INSTALLING_OPENCLAW");
      return c;
    });
    let ip = server.publicIpv4;
    for (let i = 0; i < 30; i += 1) {
      const s = await deps.hetzner.getServer(server.id);
      if (s.publicIpv4) {
        ip = s.publicIpv4;
      }
      if (s.status === "running" && ip) {
        break;
      }
      await sleep(1_000);
    }
    if (!ip) {
      throw new Error("Server has no public IPv4 after wait");
    }
    await deps.store.update(telegramUserId, (c) => {
      if (!c) {
        throw new Error("missing record");
      }
      c.serverIp = ip;
      recordTransition(c, "CONFIGURING_OPENCLAW");
      return c;
    });

    // VERIFYING → READY.
    await deps.store.update(telegramUserId, (c) => {
      if (!c) {
        throw new Error("missing record");
      }
      recordTransition(c, "VERIFYING");
      return c;
    });
    let healthy = false;
    for (let i = 0; i < 60; i += 1) {
      try {
        const status = await deps.healthProbe(ip);
        if (isGatewayHealthyStatus(status)) {
          healthy = true;
          break;
        }
      } catch {
        // Server still booting; retry.
      }
      await sleep(1_000);
    }
    if (!healthy) {
      throw new Error("Gateway health check timed out");
    }
    await deps.store.update(telegramUserId, (c) => {
      if (!c) {
        throw new Error("missing record");
      }
      recordTransition(c, "READY");
      return c;
    });
    await deps.notify(
      telegramUserId,
      `✅ Ready! Your bot @${input.botUsername} is live.\nSSH: ssh root@${ip} (tunnel 18789 for the Control UI)`,
    );
  } catch (error) {
    await fail(error);
  }
}

export async function retryFailed(
  deps: Pick<OrchestratorDeps, "store">,
  telegramUserId: string,
): Promise<void> {
  await deps.store.update(telegramUserId, (c) => {
    if (!c) {
      throw new Error("No provisioning found. Send /install first.");
    }
    recordTransition(c, "REQUESTED");
    return c;
  });
}
