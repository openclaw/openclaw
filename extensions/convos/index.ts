import type { IncomingMessage, ServerResponse } from "node:http";
import type { OpenClawConfig, OpenClawPluginApi } from "openclaw/plugin-sdk";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import type { ConvosSDKClient } from "./src/sdk-client.js";
import { resolveConvosAccount, type CoreConfig } from "./src/accounts.js";
import { convosPlugin } from "./src/channel.js";
import { registerConvosCommands } from "./src/convos-commands.js";
import { getConvosRuntime, setConvosRuntime, setConvosSetupActive } from "./src/runtime.js";
import { resolveConvosDbPath } from "./src/sdk-client.js";
import { setupConvosWithInvite } from "./src/setup.js";

// Module-level state for setup agent (accepts join requests during setup flow)
let setupAgent: ConvosSDKClient | null = null;
let setupJoinState = { joined: false, joinerInboxId: null as string | null };
let setupCleanupTimer: ReturnType<typeof setTimeout> | null = null;

// Deferred config: stored after setup, written on convos.setup.complete
let setupResult: {
  privateKey: string;
  conversationId: string;
  env: "production" | "dev";
  accountId?: string;
  inboxId?: string;
} | null = null;

// Cached setup response (so repeated calls don't destroy the running agent)
let cachedSetupResponse: {
  inviteUrl: string;
  conversationId: string;
  inboxId?: string;
} | null = null;

async function cleanupSetupAgent() {
  if (setupCleanupTimer) {
    clearTimeout(setupCleanupTimer);
    setupCleanupTimer = null;
  }
  if (setupAgent) {
    try {
      await setupAgent.stop();
    } catch {
      // Ignore cleanup errors
    }
    setupAgent = null;
  }
  cachedSetupResponse = null;
  setConvosSetupActive(false);
}

// --- Core handlers shared by WebSocket gateway methods and HTTP routes ---

/**
 * Delete the old XMTP DB directory for the current account/env/key.
 * Only deletes if the resolved path is inside the expected stateDir prefix.
 */
function deleteOldDbFiles(accountId?: string, env?: "production" | "dev") {
  try {
    const runtime = getConvosRuntime();
    const cfg = runtime.config.loadConfig() as OpenClawConfig;
    const account = resolveConvosAccount({ cfg: cfg as CoreConfig, accountId });
    if (!account.privateKey) return;

    const stateDir = runtime.state.resolveStateDir();
    const dbPath = resolveConvosDbPath({
      stateDir,
      env: env ?? account.env,
      accountId: account.accountId,
      privateKey: account.privateKey,
    });

    // Delete the hash directory (parent of xmtp.db file)
    const hashDir = path.dirname(dbPath);
    const safePrefix = path.join(stateDir, "convos", "xmtp");
    if (!hashDir.startsWith(safePrefix)) {
      console.error(`[convos-reset] Refusing to delete path outside safe prefix: ${hashDir}`);
      return;
    }

    fs.rmSync(hashDir, { recursive: true, force: true });
    console.log(`[convos-reset] Deleted old DB directory: ${hashDir}`);
  } catch (err) {
    console.error(`[convos-reset] Failed to delete old DB files:`, err);
  }
}

async function handleSetup(params: {
  accountId?: string;
  env?: "production" | "dev";
  name?: string;
  force?: boolean;
  forceNewKey?: boolean;
  deleteDb?: boolean;
}) {
  // If a setup agent is already running and we have a cached response, return it
  // (prevents repeated calls from destroying the listening agent)
  if (!params.force && setupAgent?.isRunning() && cachedSetupResponse) {
    console.log("[convos-setup] Returning cached setup (agent already running)");
    return cachedSetupResponse;
  }

  await cleanupSetupAgent();
  setupJoinState = { joined: false, joinerInboxId: null };
  cachedSetupResponse = null;

  // Optionally delete old XMTP DB files before starting fresh setup
  if (params.deleteDb) {
    deleteOldDbFiles(params.accountId, params.env);
  }

  const result = await setupConvosWithInvite({
    accountId: params.accountId,
    env: params.env,
    name: params.name,
    forceNewKey: params.forceNewKey,
    keepRunning: true,
    onInvite: async (ctx) => {
      console.log(`[convos-setup] Join request from ${ctx.joinerInboxId}`);
      try {
        await ctx.accept();
        setupJoinState = { joined: true, joinerInboxId: ctx.joinerInboxId };
        console.log(`[convos-setup] Accepted join from ${ctx.joinerInboxId}`);
      } catch (err) {
        console.error(`[convos-setup] Failed to accept join:`, err);
      }
    },
  });

  if (result.client) {
    setupAgent = result.client;
    setConvosSetupActive(true);
    console.log("[convos-setup] Agent kept running to accept join requests");
    setupCleanupTimer = setTimeout(
      async () => {
        console.log("[convos-setup] Timeout - stopping setup agent");
        setupResult = null;
        await cleanupSetupAgent();
      },
      10 * 60 * 1000,
    );
  }

  setupResult = {
    privateKey: result.privateKey,
    conversationId: result.conversationId,
    env: params.env ?? "production",
    accountId: params.accountId,
    inboxId: result.inboxId,
  };

  if (result.inboxId) {
    console.log("[convos-setup] XMTP public key (inboxId):", result.inboxId);
  }

  cachedSetupResponse = {
    inviteUrl: result.inviteUrl,
    conversationId: result.conversationId,
    inboxId: result.inboxId,
  };

  return cachedSetupResponse;
}

function handleStatus() {
  if (cachedSetupResponse?.inviteUrl) {
    return {
      active: setupAgent !== null,
      joined: setupJoinState.joined,
      joinerInboxId: setupJoinState.joinerInboxId,
      inviteUrl: cachedSetupResponse.inviteUrl,
      conversationId: cachedSetupResponse.conversationId,
    };
  }
  const cfg = getConvosRuntime().config.loadConfig() as OpenClawConfig;
  const convos = (cfg?.channels as Record<string, unknown>)?.["convos"] as
    | Record<string, unknown>
    | undefined;
  return {
    active: false,
    joined: !!convos?.privateKey,
    joinerInboxId: setupJoinState.joinerInboxId,
    inviteUrl: convos?.inviteUrl as string | undefined,
    conversationId: convos?.ownerConversationId as string | undefined,
  };
}

async function handleCancel() {
  const wasActive = setupAgent !== null;
  setupResult = null;
  await cleanupSetupAgent();
  setupJoinState = { joined: false, joinerInboxId: null };
  return { cancelled: wasActive };
}

async function handleComplete() {
  if (!setupResult) {
    throw new Error("No active setup to complete. Run convos.setup first.");
  }

  const runtime = getConvosRuntime();
  const cfg = runtime.config.loadConfig() as OpenClawConfig;

  const existingChannels = (cfg as Record<string, unknown>).channels as
    | Record<string, unknown>
    | undefined;
  const existingConvos = (existingChannels?.convos ?? {}) as Record<string, unknown>;

  // Auto-add the joiner's inbox ID to allowFrom so the operator can
  // message the agent immediately after setup (no pairing prompt).
  const existingAllowFrom = (
    Array.isArray(existingConvos.allowFrom) ? existingConvos.allowFrom : []
  ) as Array<string | number>;
  const joinerInboxId = setupJoinState.joinerInboxId;
  const allowFrom =
    joinerInboxId && !existingAllowFrom.includes(joinerInboxId)
      ? [...existingAllowFrom, joinerInboxId]
      : existingAllowFrom;

  const existingXmtp = (existingChannels?.xmtp ?? {}) as Record<string, unknown>;
  const dbEncryptionKey = randomBytes(32).toString("hex");

  const updatedCfg = {
    ...cfg,
    channels: {
      ...existingChannels,
      convos: {
        ...existingConvos,
        privateKey: setupResult.privateKey,
        ownerConversationId: setupResult.conversationId,
        env: setupResult.env,
        enabled: true,
        ...(setupResult.inboxId ? { inboxId: setupResult.inboxId } : {}),
        ...(allowFrom.length > 0 ? { allowFrom } : {}),
        inviteUrl: (cachedSetupResponse?.inviteUrl ?? existingConvos.inviteUrl) as
          | string
          | undefined,
      },
      xmtp: {
        ...existingXmtp,
        walletKey: setupResult.privateKey,
        dbEncryptionKey,
        env: setupResult.env,
        enabled: true,
        ...(allowFrom.length > 0 ? { allowFrom } : {}),
      },
    },
  };

  await runtime.config.writeConfigFile(updatedCfg);
  console.log("[convos-setup] Config saved successfully (Convos + XMTP)");

  const saved = { ...setupResult };
  setupResult = null;
  await cleanupSetupAgent();

  return { saved: true, conversationId: saved.conversationId };
}

// --- HTTP helpers ---

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString();
  if (!raw.trim()) return {};
  return JSON.parse(raw) as Record<string, unknown>;
}

function jsonResponse(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

// --- Plugin ---

const plugin = {
  id: "convos",
  name: "Convos",
  description: "E2E encrypted messaging via XMTP",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    setConvosRuntime(api.runtime);
    api.registerChannel({ plugin: convosPlugin });
    registerConvosCommands(api);

    // ---- WebSocket gateway methods (for Control UI) ----

    api.registerGatewayMethod("convos.setup", async ({ params, respond }) => {
      try {
        const p = params as Record<string, unknown>;
        const result = await handleSetup({
          accountId: typeof p.accountId === "string" ? p.accountId : undefined,
          env: typeof p.env === "string" ? (p.env as "production" | "dev") : undefined,
          name: typeof p.name === "string" ? p.name : undefined,
          force: p.force === true,
        });
        respond(true, result, undefined);
      } catch (err) {
        await cleanupSetupAgent();
        respond(false, undefined, {
          code: -1,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    });

    api.registerGatewayMethod("convos.setup.status", async ({ respond }) => {
      respond(true, handleStatus(), undefined);
    });

    api.registerGatewayMethod("convos.setup.complete", async ({ respond }) => {
      try {
        const result = await handleComplete();
        respond(true, result, undefined);
      } catch (err) {
        respond(false, undefined, {
          code: -1,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    });

    api.registerGatewayMethod("convos.setup.cancel", async ({ respond }) => {
      const result = await handleCancel();
      respond(true, result, undefined);
    });

    api.registerGatewayMethod("convos.reset", async ({ params, respond }) => {
      try {
        const p = params as Record<string, unknown>;
        const result = await handleSetup({
          accountId: typeof p.accountId === "string" ? p.accountId : undefined,
          env: typeof p.env === "string" ? (p.env as "production" | "dev") : undefined,
          force: true,
          forceNewKey: true,
          deleteDb: p.deleteDb === true,
        });
        respond(true, result, undefined);
      } catch (err) {
        await cleanupSetupAgent();
        respond(false, undefined, {
          code: -1,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    });

    // ---- HTTP routes (for Railway template and other HTTP clients) ----

    api.registerHttpRoute({
      path: "/convos/setup",
      handler: async (req, res) => {
        if (req.method !== "POST") {
          jsonResponse(res, 405, { error: "Method Not Allowed" });
          return;
        }
        try {
          const body = await readJsonBody(req);
          const result = await handleSetup({
            accountId: typeof body.accountId === "string" ? body.accountId : undefined,
            env: typeof body.env === "string" ? (body.env as "production" | "dev") : undefined,
            name: typeof body.name === "string" ? body.name : undefined,
            force: body.force === true,
          });
          jsonResponse(res, 200, result);
        } catch (err) {
          await cleanupSetupAgent();
          jsonResponse(res, 500, { error: err instanceof Error ? err.message : String(err) });
        }
      },
    });

    api.registerHttpRoute({
      path: "/convos/setup/status",
      handler: async (req, res) => {
        if (req.method !== "GET") {
          jsonResponse(res, 405, { error: "Method Not Allowed" });
          return;
        }
        jsonResponse(res, 200, handleStatus());
      },
    });

    api.registerHttpRoute({
      path: "/convos/setup/complete",
      handler: async (req, res) => {
        if (req.method !== "POST") {
          jsonResponse(res, 405, { error: "Method Not Allowed" });
          return;
        }
        try {
          const result = await handleComplete();
          jsonResponse(res, 200, result);
        } catch (err) {
          jsonResponse(res, 400, { error: err instanceof Error ? err.message : String(err) });
        }
      },
    });

    api.registerHttpRoute({
      path: "/convos/setup/cancel",
      handler: async (req, res) => {
        if (req.method !== "POST") {
          jsonResponse(res, 405, { error: "Method Not Allowed" });
          return;
        }
        const result = await handleCancel();
        jsonResponse(res, 200, result);
      },
    });

    api.registerHttpRoute({
      path: "/convos/reset",
      handler: async (req, res) => {
        if (req.method !== "POST") {
          jsonResponse(res, 405, { error: "Method Not Allowed" });
          return;
        }
        try {
          const body = await readJsonBody(req);
          const result = await handleSetup({
            accountId: typeof body.accountId === "string" ? body.accountId : undefined,
            env: typeof body.env === "string" ? (body.env as "production" | "dev") : undefined,
            force: true,
            forceNewKey: true,
            deleteDb: body.deleteDb === true,
          });
          jsonResponse(res, 200, result);
        } catch (err) {
          await cleanupSetupAgent();
          jsonResponse(res, 500, { error: err instanceof Error ? err.message : String(err) });
        }
      },
    });
  },
};

export default plugin;
