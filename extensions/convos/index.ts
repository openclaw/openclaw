import type { IncomingMessage, ServerResponse } from "node:http";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { emptyPluginConfigSchema, renderQrPngBase64 } from "openclaw/plugin-sdk";
import { resolveConvosAccount, type CoreConfig } from "./src/accounts.js";
import { convosPlugin, startWiredInstance } from "./src/channel.js";
import { getConvosInstance, setConvosInstance } from "./src/outbound.js";
import { getConvosRuntime, setConvosRuntime, setConvosSetupActive } from "./src/runtime.js";
import { ConvosInstance } from "./src/sdk-client.js";
import { setupConvosWithInvite } from "./src/setup.js";

// Module-level state for setup instance (accepts join requests during setup flow)
let setupInstance: ConvosInstance | null = null;
let setupJoinState = { joined: false, joinerInboxId: null as string | null };
let setupCleanupTimer: ReturnType<typeof setTimeout> | null = null;

// Deferred config: stored after setup, written on convos.setup.complete
let setupResult: {
  identityId: string;
  conversationId: string;
  env: "production" | "dev";
  accountId?: string;
} | null = null;

// Cached setup response (so repeated calls don't destroy the running instance)
let cachedSetupResponse: {
  inviteUrl: string;
  conversationId: string;
  qrDataUrl: string;
} | null = null;

async function cleanupSetupInstance() {
  if (setupCleanupTimer) {
    clearTimeout(setupCleanupTimer);
    setupCleanupTimer = null;
  }
  if (setupInstance) {
    try {
      await setupInstance.stop();
    } catch {
      // Ignore cleanup errors
    }
    setupInstance = null;
  }
  cachedSetupResponse = null;
  setConvosSetupActive(false);
}

// --- Core handlers shared by WebSocket gateway methods and HTTP routes ---

async function handleSetup(params: {
  accountId?: string;
  env?: "production" | "dev";
  name?: string;
  force?: boolean;
}) {
  // If a setup instance is already running and we have a cached response, return it
  if (!params.force && setupInstance?.isRunning() && cachedSetupResponse) {
    console.log("[convos-setup] Returning cached setup (instance already running)");
    return cachedSetupResponse;
  }

  await cleanupSetupInstance();
  setupJoinState = { joined: false, joinerInboxId: null };
  cachedSetupResponse = null;

  const result = await setupConvosWithInvite(
    {
      accountId: params.accountId,
      env: params.env,
      name: params.name,
    },
    {
      onJoinAccepted: (info) => {
        setupJoinState = { joined: true, joinerInboxId: info.joinerInboxId };
        console.log(`[convos-setup] Join accepted: ${info.joinerInboxId}`);
      },
    },
  );

  if (result.instance) {
    setupInstance = result.instance;
    // Start the instance so it processes join requests via CLI child process
    await setupInstance.start();
    setConvosSetupActive(true);
    console.log("[convos-setup] Instance running to accept join requests");
    setupCleanupTimer = setTimeout(
      async () => {
        console.log("[convos-setup] Timeout - stopping setup instance");
        setupResult = null;
        await cleanupSetupInstance();
      },
      10 * 60 * 1000,
    );
  }

  setupResult = {
    identityId: result.identityId,
    conversationId: result.conversationId,
    env: params.env ?? "production",
    accountId: params.accountId,
  };

  const qrBase64 = await renderQrPngBase64(result.inviteUrl);

  cachedSetupResponse = {
    inviteUrl: result.inviteUrl,
    conversationId: result.conversationId,
    qrDataUrl: `data:image/png;base64,${qrBase64}`,
  };

  return cachedSetupResponse;
}

function handleStatus() {
  return {
    active: setupInstance !== null,
    joined: setupJoinState.joined,
    joinerInboxId: setupJoinState.joinerInboxId,
  };
}

async function handleCancel() {
  const wasActive = setupInstance !== null;
  setupResult = null;
  await cleanupSetupInstance();
  setupJoinState = { joined: false, joinerInboxId: null };
  return { cancelled: wasActive };
}

async function handleComplete() {
  if (!setupResult) {
    throw new Error("No active setup to complete. Run convos.setup first.");
  }

  const runtime = getConvosRuntime();
  const cfg = runtime.config.loadConfig();

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

  const updatedCfg = {
    ...cfg,
    channels: {
      ...existingChannels,
      convos: {
        ...existingConvos,
        identityId: setupResult.identityId,
        ownerConversationId: setupResult.conversationId,
        env: setupResult.env,
        enabled: true,
        ...(allowFrom.length > 0 ? { allowFrom } : {}),
      },
    },
  };

  await runtime.config.writeConfigFile(updatedCfg);
  console.log("[convos-setup] Config saved successfully");

  const saved = { ...setupResult };
  setupResult = null;
  await cleanupSetupInstance();

  return { saved: true, conversationId: saved.conversationId };
}

// --- HTTP helpers ---

const MAX_BODY_BYTES = 1024 * 1024; // 1 MB

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let totalSize = 0;
  for await (const chunk of req) {
    totalSize += (chunk as Buffer).length;
    if (totalSize > MAX_BODY_BYTES) {
      throw new Error("Request body too large");
    }
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString();
  if (!raw.trim()) {
    return {};
  }
  return JSON.parse(raw) as Record<string, unknown>;
}

function jsonResponse(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

function checkPoolAuth(req: IncomingMessage): boolean {
  const runtime = getConvosRuntime();
  const cfg = runtime.config.loadConfig() as Record<string, unknown>;
  const channels = cfg.channels as Record<string, unknown> | undefined;
  const convos = channels?.convos as Record<string, unknown> | undefined;
  const poolApiKey = convos?.poolApiKey as string | undefined;
  if (!poolApiKey) return true; // No poolApiKey configured — allow all
  const authHeader = req.headers.authorization;
  return authHeader === `Bearer ${poolApiKey}`;
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

    // ---- WebSocket gateway methods (for Control UI) ----

    api.registerGatewayMethod("convos.setup", async ({ params, respond }) => {
      try {
        const result = await handleSetup({
          accountId: typeof params.accountId === "string" ? params.accountId : undefined,
          env: typeof params.env === "string" ? (params.env as "production" | "dev") : undefined,
          name: typeof params.name === "string" ? params.name : undefined,
          force: params.force === true,
        });
        respond(true, result, undefined);
      } catch (err) {
        await cleanupSetupInstance();
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
        const result = await handleSetup({
          accountId: typeof params.accountId === "string" ? params.accountId : undefined,
          env: typeof params.env === "string" ? (params.env as "production" | "dev") : undefined,
          force: true,
        });
        respond(true, result, undefined);
      } catch (err) {
        await cleanupSetupInstance();
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
        if (!checkPoolAuth(req)) {
          jsonResponse(res, 401, { error: "Unauthorized" });
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
          await cleanupSetupInstance();
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
        if (!checkPoolAuth(req)) {
          jsonResponse(res, 401, { error: "Unauthorized" });
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
        if (!checkPoolAuth(req)) {
          jsonResponse(res, 401, { error: "Unauthorized" });
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
        if (!checkPoolAuth(req)) {
          jsonResponse(res, 401, { error: "Unauthorized" });
          return;
        }
        const result = await handleCancel();
        jsonResponse(res, 200, result);
      },
    });

    // Create a new conversation via CLI. Used by pool manager for provisioning.
    api.registerHttpRoute({
      path: "/convos/conversation",
      handler: async (req, res) => {
        if (req.method !== "POST") {
          jsonResponse(res, 405, { error: "Method Not Allowed" });
          return;
        }
        if (!checkPoolAuth(req)) {
          jsonResponse(res, 401, { error: "Unauthorized" });
          return;
        }
        try {
          // Guard: reject if instance already bound
          if (getConvosInstance()) {
            jsonResponse(res, 409, {
              error:
                "Instance already bound to a conversation. Terminate process and provision a new one.",
            });
            return;
          }

          const body = await readJsonBody(req);
          const name = typeof body.name === "string" ? body.name : "Convos Agent";
          const profileName = typeof body.profileName === "string" ? body.profileName : name;
          const profileImage =
            typeof body.profileImage === "string" ? body.profileImage : undefined;
          const description = typeof body.description === "string" ? body.description : undefined;
          const imageUrl = typeof body.imageUrl === "string" ? body.imageUrl : undefined;
          const permissions =
            body.permissions === "all-members" || body.permissions === "admin-only"
              ? body.permissions
              : undefined;
          const accountId = typeof body.accountId === "string" ? body.accountId : undefined;

          // Write instructions file for the agent if provided
          const instructions =
            typeof body.instructions === "string" ? body.instructions : undefined;
          if (instructions && instructions.trim()) {
            const wsDir = path.join(os.homedir(), ".openclaw", "workspace");
            fs.mkdirSync(wsDir, { recursive: true });
            fs.writeFileSync(path.join(wsDir, "INSTRUCTIONS.md"), instructions);
          }

          const runtime = getConvosRuntime();
          const cfg = runtime.config.loadConfig();
          const account = resolveConvosAccount({ cfg: cfg as CoreConfig, accountId });
          const env = body.env === "dev" || body.env === "production" ? body.env : account.env;

          const { instance, result } = await ConvosInstance.create(env, {
            name,
            profileName,
            description,
            imageUrl,
            permissions,
          });

          // Save to config so startAccount can restore on restart
          const existingChannels = (cfg as Record<string, unknown>).channels as
            | Record<string, unknown>
            | undefined;
          const existingConvos = (existingChannels?.convos ?? {}) as Record<string, unknown>;
          await runtime.config.writeConfigFile({
            ...cfg,
            channels: {
              ...existingChannels,
              convos: {
                ...existingConvos,
                identityId: instance.identityId,
                ownerConversationId: result.conversationId,
                env,
                enabled: true,
              },
            },
          });

          // Start with full message handling pipeline (must happen before
          // updateProfile so the join-approval stream handler is active)
          await startWiredInstance({
            conversationId: result.conversationId,
            identityId: instance.identityId,
            env,
          });

          jsonResponse(res, 200, {
            conversationId: result.conversationId,
            inviteUrl: result.inviteUrl,
            inviteSlug: result.inviteSlug,
          });
        } catch (err) {
          jsonResponse(res, 500, { error: err instanceof Error ? err.message : String(err) });
        }
      },
    });

    // Join an existing conversation via invite URL.
    // Used by pool manager to join a user-created conversation.
    api.registerHttpRoute({
      path: "/convos/join",
      handler: async (req, res) => {
        if (req.method !== "POST") {
          jsonResponse(res, 405, { error: "Method Not Allowed" });
          return;
        }
        if (!checkPoolAuth(req)) {
          jsonResponse(res, 401, { error: "Unauthorized" });
          return;
        }
        try {
          // Guard: reject if instance already bound
          if (getConvosInstance()) {
            jsonResponse(res, 409, {
              error:
                "Instance already bound to a conversation. Terminate process and provision a new one.",
            });
            return;
          }

          const body = await readJsonBody(req);
          const inviteUrl = typeof body.inviteUrl === "string" ? body.inviteUrl : undefined;
          if (!inviteUrl) {
            jsonResponse(res, 400, { error: "inviteUrl (string) is required" });
            return;
          }
          const profileName =
            typeof body.profileName === "string" ? body.profileName : "Convos Agent";
          const profileImage =
            typeof body.profileImage === "string" ? body.profileImage : undefined;
          const accountId = typeof body.accountId === "string" ? body.accountId : undefined;

          // Write instructions file for the agent if provided
          const instructions =
            typeof body.instructions === "string" ? body.instructions : undefined;
          if (instructions && instructions.trim()) {
            const wsDir = path.join(os.homedir(), ".openclaw", "workspace");
            fs.mkdirSync(wsDir, { recursive: true });
            fs.writeFileSync(path.join(wsDir, "INSTRUCTIONS.md"), instructions);
          }

          const runtime = getConvosRuntime();
          const cfg = runtime.config.loadConfig();
          const account = resolveConvosAccount({ cfg: cfg as CoreConfig, accountId });
          const env = body.env === "dev" || body.env === "production" ? body.env : account.env;

          const { instance, status, conversationId } = await ConvosInstance.join(env, inviteUrl, {
            profileName,
            timeout: 60,
          });

          if (status !== "joined" || !conversationId || !instance) {
            jsonResponse(res, 200, { status: "waiting_for_acceptance" });
            return;
          }

          // Save to config
          const existingChannels = (cfg as Record<string, unknown>).channels as
            | Record<string, unknown>
            | undefined;
          const existingConvos = (existingChannels?.convos ?? {}) as Record<string, unknown>;
          await runtime.config.writeConfigFile({
            ...cfg,
            channels: {
              ...existingChannels,
              convos: {
                ...existingConvos,
                identityId: instance.identityId,
                ownerConversationId: conversationId,
                env,
                enabled: true,
              },
            },
          });

          // Start with full message handling pipeline
          await startWiredInstance({
            conversationId,
            identityId: instance.identityId,
            env,
          });

          jsonResponse(res, 200, { status: "joined", conversationId });
        } catch (err) {
          jsonResponse(res, 500, { error: err instanceof Error ? err.message : String(err) });
        }
      },
    });

    // Send a message into the active conversation.
    api.registerHttpRoute({
      path: "/convos/conversation/send",
      handler: async (req, res) => {
        if (req.method !== "POST") {
          jsonResponse(res, 405, { error: "Method Not Allowed" });
          return;
        }
        if (!checkPoolAuth(req)) {
          jsonResponse(res, 401, { error: "Unauthorized" });
          return;
        }
        try {
          const inst = getConvosInstance();
          if (!inst) {
            jsonResponse(res, 400, { error: "No active conversation" });
            return;
          }

          const body = await readJsonBody(req);
          const message = typeof body.message === "string" ? body.message : undefined;
          if (!message) {
            jsonResponse(res, 400, { error: "message (string) is required" });
            return;
          }

          const result = await inst.sendMessage(message);
          jsonResponse(res, 200, result);
        } catch (err) {
          jsonResponse(res, 500, { error: err instanceof Error ? err.message : String(err) });
        }
      },
    });

    // Rename conversation + agent profile name.
    api.registerHttpRoute({
      path: "/convos/rename",
      handler: async (req, res) => {
        if (req.method !== "POST") {
          jsonResponse(res, 405, { error: "Method Not Allowed" });
          return;
        }
        if (!checkPoolAuth(req)) {
          jsonResponse(res, 401, { error: "Unauthorized" });
          return;
        }
        try {
          const inst = getConvosInstance();
          if (!inst) {
            jsonResponse(res, 400, { error: "No active conversation" });
            return;
          }

          const body = await readJsonBody(req);
          const name = typeof body.name === "string" ? body.name : undefined;
          if (!name) {
            jsonResponse(res, 400, { error: "name (string) is required" });
            return;
          }

          await inst.rename(name);
          jsonResponse(res, 200, { ok: true });
        } catch (err) {
          jsonResponse(res, 500, { error: err instanceof Error ? err.message : String(err) });
        }
      },
    });

    // Lock/unlock the conversation.
    api.registerHttpRoute({
      path: "/convos/lock",
      handler: async (req, res) => {
        if (req.method !== "POST") {
          jsonResponse(res, 405, { error: "Method Not Allowed" });
          return;
        }
        if (!checkPoolAuth(req)) {
          jsonResponse(res, 401, { error: "Unauthorized" });
          return;
        }
        try {
          const inst = getConvosInstance();
          if (!inst) {
            jsonResponse(res, 400, { error: "No active conversation" });
            return;
          }

          const body = await readJsonBody(req);
          const unlock = body.unlock === true;
          if (unlock) {
            await inst.unlock();
          } else {
            await inst.lock();
          }
          jsonResponse(res, 200, { ok: true, locked: !unlock });
        } catch (err) {
          jsonResponse(res, 500, { error: err instanceof Error ? err.message : String(err) });
        }
      },
    });

    // Explode (destroy) the conversation.
    api.registerHttpRoute({
      path: "/convos/explode",
      handler: async (req, res) => {
        if (req.method !== "POST") {
          jsonResponse(res, 405, { error: "Method Not Allowed" });
          return;
        }
        if (!checkPoolAuth(req)) {
          jsonResponse(res, 401, { error: "Unauthorized" });
          return;
        }
        try {
          const inst = getConvosInstance();
          if (!inst) {
            jsonResponse(res, 400, { error: "No active conversation" });
            return;
          }

          await inst.explode();
          setConvosInstance(null);
          jsonResponse(res, 200, { ok: true, exploded: true });
        } catch (err) {
          jsonResponse(res, 500, { error: err instanceof Error ? err.message : String(err) });
        }
      },
    });

    // Health/status: reports whether the instance is bound and streaming.
    api.registerHttpRoute({
      path: "/convos/status",
      handler: async (req, res) => {
        if (req.method !== "GET") {
          jsonResponse(res, 405, { error: "Method Not Allowed" });
          return;
        }
        if (!checkPoolAuth(req)) {
          jsonResponse(res, 401, { error: "Unauthorized" });
          return;
        }
        const inst = getConvosInstance();
        if (!inst) {
          jsonResponse(res, 200, { ready: true, conversation: null, streaming: false });
          return;
        }
        jsonResponse(res, 200, {
          ready: true,
          conversation: { id: inst.conversationId },
          streaming: inst.isStreaming(),
        });
      },
    });

    // Reset: re-run setup with a fresh identity.
    api.registerHttpRoute({
      path: "/convos/reset",
      handler: async (req, res) => {
        if (req.method !== "POST") {
          jsonResponse(res, 405, { error: "Method Not Allowed" });
          return;
        }
        if (!checkPoolAuth(req)) {
          jsonResponse(res, 401, { error: "Unauthorized" });
          return;
        }
        try {
          const body = await readJsonBody(req);
          const result = await handleSetup({
            accountId: typeof body.accountId === "string" ? body.accountId : undefined,
            env: typeof body.env === "string" ? (body.env as "production" | "dev") : undefined,
            force: true,
          });
          jsonResponse(res, 200, result);
        } catch (err) {
          await cleanupSetupInstance();
          jsonResponse(res, 500, { error: err instanceof Error ? err.message : String(err) });
        }
      },
    });
  },
};

export default plugin;
