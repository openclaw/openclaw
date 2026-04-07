/**
 * Agent Webhook HTTP Entry Point
 *
 * Responsibilities:
 * 1. Manage AgentWebhookTarget registry (multiple accounts sharing the same path are matched by signature)
 * 2. GET  → echostr URL verification
 * 3. POST → XML body decryption → call handleAgentWebhook
 */

import crypto from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { WecomCrypto } from "@wecom/aibot-node-sdk";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import { WEBHOOK_PATHS, LIMITS } from "../const.js";
import { parseXml, extractAgentId } from "../shared/xml-parser.js";
import type { ResolvedAgentAccount } from "../types/index.js";
import { handleAgentWebhook } from "./index.js";
import { extractEncryptFromXml } from "./xml.js";

// ============================================================================
// Types
// ============================================================================

export type AgentWebhookTarget = {
  agent: ResolvedAgentAccount;
  config: OpenClawConfig;
  runtime: {
    log?: (msg: string) => void;
    error?: (msg: string) => void;
  };
  path: string;
};

// ============================================================================
// Target Registry
// ============================================================================

const agentTargets = new Map<string, AgentWebhookTarget[]>();

export function registerAgentWebhookTarget(target: AgentWebhookTarget): void {
  const list = agentTargets.get(target.path) ?? [];
  list.push(target);
  agentTargets.set(target.path, list);
}

export function deregisterAgentWebhookTarget(accountId: string): void {
  for (const [path, list] of agentTargets) {
    const filtered = list.filter((t) => t.agent.accountId !== accountId);
    if (filtered.length === 0) {
      agentTargets.delete(path);
    } else {
      agentTargets.set(path, filtered);
    }
  }
}

// ============================================================================
// Helpers
// ============================================================================

function normalizeWebhookPath(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    return "/";
  }
  const withSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  if (withSlash.length > 1 && withSlash.endsWith("/")) {
    return withSlash.slice(0, -1);
  }
  return withSlash;
}

function resolvePath(req: IncomingMessage): string {
  const url = new URL(req.url ?? "/", "http://localhost");
  return normalizeWebhookPath(url.pathname || "/");
}

function resolveQueryParams(req: IncomingMessage): URLSearchParams {
  const url = new URL(req.url ?? "/", "http://localhost");
  return url.searchParams;
}

function resolveSignatureParam(params: URLSearchParams): string {
  return params.get("msg_signature") ?? params.get("msgsignature") ?? params.get("signature") ?? "";
}

async function readTextBody(
  req: IncomingMessage,
  maxBytes: number,
): Promise<{ ok: true; value: string } | { ok: false; error: string }> {
  const chunks: Buffer[] = [];
  let total = 0;
  return await new Promise((resolve) => {
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        resolve({ ok: false as const, error: "payload too large" });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      resolve({ ok: true as const, value: Buffer.concat(chunks).toString("utf8") });
    });
    req.on("error", (err) => {
      resolve({ ok: false as const, error: err instanceof Error ? err.message : String(err) });
    });
  });
}

function normalizeAgentIdValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  // oxlint-disable-next-line typescript/no-base-to-string -- SDK response fields have unknown shape
  const raw = String(value ?? "").trim();
  if (!raw) {
    return undefined;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

// ============================================================================
// Main HTTP handler
// ============================================================================

export function createWecomAgentWebhookHandler(runtime: PluginRuntime) {
  return (req: IncomingMessage, res: ServerResponse) =>
    handleWecomAgentWebhookRequest(req, res, runtime);
}

export async function handleWecomAgentWebhookRequest(
  req: IncomingMessage,
  res: ServerResponse,
  runtime: PluginRuntime,
): Promise<boolean | void> {
  const path = resolvePath(req);
  const reqId = crypto.randomUUID().slice(0, 8);

  // Check if this is an Agent path
  const isAgentPath =
    path === WEBHOOK_PATHS.AGENT ||
    path === WEBHOOK_PATHS.AGENT_PLUGIN ||
    path.startsWith(`${WEBHOOK_PATHS.AGENT}/`) ||
    path.startsWith(`${WEBHOOK_PATHS.AGENT_PLUGIN}/`);

  const targets = agentTargets.get(path) ?? [];

  if (targets.length === 0) {
    if (isAgentPath) {
      res.statusCode = 404;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("agent not configured - Agent 模式未配置");
      return true;
    }
    return false;
  }

  const query = resolveQueryParams(req);
  const timestamp = query.get("timestamp") ?? "";
  const nonce = query.get("nonce") ?? "";
  const signature = resolveSignatureParam(query);

  // ── GET: echostr URL verification ──────────────────────────────────────────
  if (req.method === "GET") {
    const echostr = query.get("echostr") ?? "";
    // Match the correct target by signature
    const matched = targets.filter((t) => {
      const wc = new WecomCrypto(t.agent.token, t.agent.encodingAESKey, t.agent.corpId);
      return wc.verifySignature(signature, timestamp, nonce, echostr);
    });
    if (matched.length !== 1) {
      const reason = matched.length === 0 ? "account_not_found" : "account_conflict";
      res.statusCode = 401;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(
        JSON.stringify({
          error: reason,
          message: `Agent callback ${reason}: signature verification failed.`,
        }),
      );
      return true;
    }
    const selected = matched[0];
    try {
      const wc = new WecomCrypto(
        selected.agent.token,
        selected.agent.encodingAESKey,
        selected.agent.corpId,
      );
      const plain = wc.decrypt(echostr);
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end(plain);
      return true;
    } catch {
      res.statusCode = 400;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("decrypt failed - 解密失败，请检查 EncodingAESKey");
      return true;
    }
  }

  // ── POST: XML message callback ─────────────────────────────────────────────
  if (req.method !== "POST") {
    return false;
  }

  const rawBody = await readTextBody(req, LIMITS.MAX_REQUEST_BODY_SIZE);
  if (!rawBody.ok) {
    res.statusCode = 400;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end(rawBody.error || "invalid payload");
    return true;
  }

  let encrypted = "";
  try {
    encrypted = extractEncryptFromXml(rawBody.value);
  } catch {
    res.statusCode = 400;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("invalid xml - 缺少 Encrypt 字段");
    return true;
  }

  // Signature matching
  const matched = targets.filter((t) => {
    const wc = new WecomCrypto(t.agent.token, t.agent.encodingAESKey, t.agent.corpId);
    return wc.verifySignature(signature, timestamp, nonce, encrypted);
  });
  if (matched.length !== 1) {
    const reason = matched.length === 0 ? "account_not_found" : "account_conflict";
    res.statusCode = 401;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(
      JSON.stringify({
        error: reason,
        message: `Agent callback ${reason}: signature verification failed.`,
      }),
    );
    return true;
  }

  const selected = matched[0];
  let decrypted = "";
  let parsed: ReturnType<typeof parseXml> | null = null;
  try {
    const wc = new WecomCrypto(
      selected.agent.token,
      selected.agent.encodingAESKey,
      selected.agent.corpId,
    );
    decrypted = wc.decrypt(encrypted);
    parsed = parseXml(decrypted);
  } catch {
    res.statusCode = 400;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("decrypt failed - 解密失败，请检查 EncodingAESKey");
    return true;
  }
  if (!parsed) {
    res.statusCode = 400;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("invalid xml - XML 解析失败");
    return true;
  }

  // agentId consistency check (warning only)
  const inboundAgentId = normalizeAgentIdValue(extractAgentId(parsed));
  if (
    inboundAgentId !== undefined &&
    selected.agent.agentId !== undefined &&
    inboundAgentId !== selected.agent.agentId
  ) {
    selected.runtime.error?.(
      `[wecom] inbound(agent): reqId=${reqId} accountId=${selected.agent.accountId} agentId_mismatch expected=${selected.agent.agentId} actual=${inboundAgentId}`,
    );
  }

  const core = runtime;
  selected.runtime.log?.(
    `[wecom] inbound(agent): reqId=${reqId} method=POST remote=${req.socket?.remoteAddress ?? "unknown"} accountId=${selected.agent.accountId}`,
  );

  return handleAgentWebhook({
    req,
    res,
    verifiedPost: {
      timestamp,
      nonce,
      signature,
      encrypted,
      decrypted,
      parsed,
    },
    agent: selected.agent,
    config: selected.config,
    core,
    log: selected.runtime.log,
    error: selected.runtime.error,
  });
}
