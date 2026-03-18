// Authored by: cc (Claude Code) | 2026-03-18
import crypto from "node:crypto";
import http from "node:http";
import type { OpenClawConfig } from "openclaw/plugin-sdk/core";

type ThinkLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "adaptive";
type VerboseLevel = "off" | "on" | "full";
import { normalizePhoneNumber } from "./allowlist.js";
import type { SmsConfig } from "./config.js";
import { handleSmsRequest, type SmsMessage } from "./webhook.js";

const INBOX_MAX = 50;

// Typed against OpenClawPluginApi["runtime"]["agent"] — passed in from index.ts.
type AgentRuntime = {
  defaults: { model: string; provider: string };
  resolveAgentDir: (
    cfg: OpenClawConfig,
    agentId: string,
    env?: Record<string, string | undefined>,
  ) => string;
  resolveAgentWorkspaceDir: (cfg: OpenClawConfig, agentId: string) => string;
  ensureAgentWorkspace: (params: { dir: string }) => Promise<unknown>;
  resolveAgentIdentity: (cfg: OpenClawConfig, agentId: string) => { name?: string } | undefined;
  resolveThinkingDefault: (params: {
    cfg: OpenClawConfig;
    provider: string;
    model: string;
  }) => ThinkLevel;
  resolveAgentTimeoutMs: (params: { cfg: OpenClawConfig }) => number;
  session: {
    resolveStorePath: (store: string | undefined, params: { agentId: string }) => string;
    loadSessionStore: (path: string) => Record<string, SessionEntry>;
    saveSessionStore: (path: string, store: Record<string, SessionEntry>) => Promise<void>;
    resolveSessionFilePath: (
      sessionId: string,
      entry?: { sessionFile?: string },
      params?: { agentId: string },
    ) => string;
  };
  runEmbeddedPiAgent: (params: {
    sessionId: string;
    sessionKey: string;
    messageProvider: string;
    sessionFile: string;
    workspaceDir: string;
    config: OpenClawConfig;
    prompt: string;
    provider: string;
    model: string;
    thinkLevel: ThinkLevel;
    verboseLevel: VerboseLevel;
    timeoutMs: number;
    runId: string;
    lane: string;
    extraSystemPrompt: string;
    agentDir: string;
  }) => Promise<unknown>;
};

type RuntimeLogger = {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
};

export type SmsRuntime = {
  stop: () => Promise<void>;
  getInbox: () => SmsMessage[];
};

export async function createSmsRuntime(
  config: SmsConfig,
  agentRuntime: AgentRuntime,
  coreConfig: OpenClawConfig,
  logger: RuntimeLogger,
): Promise<SmsRuntime> {
  if (!config.skipSignatureVerification && (!config.publicUrl || !config.twilio?.authToken)) {
    throw new Error(
      "twilio-sms requires publicUrl and twilio.authToken when signature verification is enabled",
    );
  }

  const inbox: SmsMessage[] = [];

  const onMessage = (msg: SmsMessage): void => {
    // Ring-buffer: keep only the most recent INBOX_MAX messages.
    inbox.push(msg);
    if (inbox.length > INBOX_MAX) {
      inbox.shift();
    }

    const sessionKey = `sms:${normalizePhoneNumber(msg.from)}`;
    logger.info(`[twilio-sms] dispatching message to agent (session=${sessionKey})`);

    // Fire-and-forget — TwiML response already sent; errors are logged only.
    dispatchToAgent(msg, sessionKey, agentRuntime, coreConfig, logger).catch((err: unknown) =>
      logger.error(`[twilio-sms] agent dispatch failed: ${String(err)}`),
    );
  };

  const server = http.createServer((req, res) => {
    // Only route requests that match the configured webhook path.
    const urlPath = req.url?.split("?")[0] ?? "";
    if (urlPath !== config.serve.path) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not Found");
      return;
    }

    handleSmsRequest(req, res, { config, onMessage }).catch((err: unknown) => {
      logger.error(`[twilio-sms] webhook handler error: ${String(err)}`);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end("Internal Server Error");
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.listen(config.serve.port, config.serve.bind, resolve);
    server.on("error", reject);
  });

  logger.info(
    `[twilio-sms] webhook server listening on ${config.serve.bind}:${config.serve.port}${config.serve.path}`,
  );

  return {
    stop: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
    // Return a snapshot so callers can't mutate the internal buffer.
    getInbox: () => [...inbox],
  };
}

type SessionEntry = { sessionId: string; updatedAt: number };

async function dispatchToAgent(
  msg: SmsMessage,
  sessionKey: string,
  agentRuntime: AgentRuntime,
  cfg: OpenClawConfig,
  logger: RuntimeLogger,
): Promise<void> {
  const agentId = "main";

  const storePath = agentRuntime.session.resolveStorePath(
    (cfg as { session?: { store?: string } }).session?.store,
    { agentId },
  );
  const agentDir = agentRuntime.resolveAgentDir(cfg, agentId);
  const workspaceDir = agentRuntime.resolveAgentWorkspaceDir(cfg, agentId);
  await agentRuntime.ensureAgentWorkspace({ dir: workspaceDir });

  const sessionStore = agentRuntime.session.loadSessionStore(storePath);
  const now = Date.now();
  let sessionEntry = sessionStore[sessionKey];
  if (!sessionEntry) {
    sessionEntry = { sessionId: crypto.randomUUID(), updatedAt: now };
    sessionStore[sessionKey] = sessionEntry;
    await agentRuntime.session.saveSessionStore(storePath, sessionStore);
  }

  const sessionFile = agentRuntime.session.resolveSessionFilePath(
    sessionEntry.sessionId,
    undefined,
    { agentId },
  );

  // Read model from config (agents.defaults.model.primary), fall back to SDK defaults.
  const primaryModel = (cfg as { agents?: { defaults?: { model?: { primary?: string } } } }).agents
    ?.defaults?.model?.primary;
  const modelRef =
    primaryModel || `${agentRuntime.defaults.provider}/${agentRuntime.defaults.model}`;
  const slashIndex = modelRef.indexOf("/");
  const provider =
    slashIndex === -1 ? agentRuntime.defaults.provider : modelRef.slice(0, slashIndex);
  const model = slashIndex === -1 ? modelRef : modelRef.slice(slashIndex + 1);
  const thinkLevel = agentRuntime.resolveThinkingDefault({ cfg, provider, model });

  const identity = agentRuntime.resolveAgentIdentity(cfg, agentId);
  const agentName = identity?.name?.trim() || "assistant";
  const timeoutMs = agentRuntime.resolveAgentTimeoutMs({ cfg });
  const runId = `sms:${sessionKey}:${Date.now()}`;

  const extraSystemPrompt = `You are ${agentName}. You are receiving an SMS message. The sender's phone number is ${msg.from}. Respond helpfully and concisely.`;

  await agentRuntime.runEmbeddedPiAgent({
    sessionId: sessionEntry.sessionId,
    sessionKey,
    messageProvider: "sms",
    sessionFile,
    workspaceDir,
    config: cfg,
    prompt: `SMS from ${msg.from}: ${msg.body}`,
    provider,
    model,
    thinkLevel,
    verboseLevel: "off",
    timeoutMs,
    runId,
    lane: "sms",
    extraSystemPrompt,
    agentDir,
  });

  logger.info(`[twilio-sms] agent run complete (session=${sessionKey})`);
}
