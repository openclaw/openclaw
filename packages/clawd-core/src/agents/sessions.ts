import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import JSON5 from "json5";
import type { ClawdConfig, SessionEntry } from "../config/types.js";
import { resolveUserPath } from "../utils/index.js";

export const DEFAULT_AGENT_ID = "main";
export const DEFAULT_MAIN_KEY = "main";
export const DEFAULT_IDLE_MINUTES = 60;

export function normalizeAgentId(value: string | undefined | null): string {
  const trimmed = (value ?? "").trim();
  if (!trimmed) return DEFAULT_AGENT_ID;
  if (/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(trimmed)) return trimmed;
  return (
    trimmed
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+/, "")
      .replace(/-+$/, "")
      .slice(0, 64) || DEFAULT_AGENT_ID
  );
}

function resolveAgentSessionsDir(
  agentId?: string,
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = os.homedir,
): string {
  const override = env.CLAWD_STATE_DIR?.trim();
  const root = override
    ? resolveUserPath(override)
    : path.join(homedir(), ".clawd");
  const id = normalizeAgentId(agentId ?? DEFAULT_AGENT_ID);
  return path.join(root, "agents", id, "sessions");
}

export function resolveSessionTranscriptsDir(
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = os.homedir,
): string {
  return resolveAgentSessionsDir(DEFAULT_AGENT_ID, env, homedir);
}

export function resolveDefaultSessionStorePath(agentId?: string): string {
  return path.join(resolveAgentSessionsDir(agentId), "sessions.json");
}

export function resolveSessionTranscriptPath(
  sessionId: string,
  agentId?: string,
): string {
  return path.join(resolveAgentSessionsDir(agentId), `${sessionId}.jsonl`);
}

export function resolveStorePath(store?: string, opts?: { agentId?: string }) {
  const agentId = normalizeAgentId(opts?.agentId ?? DEFAULT_AGENT_ID);
  if (!store) return resolveDefaultSessionStorePath(agentId);
  if (store.includes("{agentId}")) {
    return path.resolve(
      store.replaceAll("{agentId}", agentId).replace("~", os.homedir()),
    );
  }
  if (store.startsWith("~"))
    return path.resolve(store.replace("~", os.homedir()));
  return path.resolve(store);
}

export function buildAgentMainSessionKey(params: {
  agentId: string;
  mainKey?: string | undefined;
}): string {
  const agentId = normalizeAgentId(params.agentId);
  const mainKey =
    (params.mainKey ?? DEFAULT_MAIN_KEY).trim() || DEFAULT_MAIN_KEY;
  return `agent:${agentId}:${mainKey}`;
}

export function resolveMainSessionKey(cfg?: ClawdConfig): string {
  if (cfg?.session?.scope === "global") return "global";
  const agentId = normalizeAgentId(DEFAULT_AGENT_ID);
  const mainKey =
    (cfg?.session?.mainKey ?? DEFAULT_MAIN_KEY).trim() || DEFAULT_MAIN_KEY;
  return buildAgentMainSessionKey({ agentId, mainKey });
}

export function loadSessionStore(
  storePath: string,
): Record<string, SessionEntry> {
  try {
    const raw = fs.readFileSync(storePath, "utf-8");
    const parsed = JSON5.parse(raw);
    if (parsed && typeof parsed === "object") {
      return parsed as Record<string, SessionEntry>;
    }
  } catch {
    // ignore missing/invalid store; we'll recreate it
  }
  return {};
}

export async function saveSessionStore(
  storePath: string,
  store: Record<string, SessionEntry>,
) {
  await fs.promises.mkdir(path.dirname(storePath), { recursive: true });
  const json = JSON.stringify(store, null, 2);
  const tmp = `${storePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.promises.writeFile(tmp, json, "utf-8");
    await fs.promises.rename(tmp, storePath);
  } catch (err) {
    const code =
      err && typeof err === "object" && "code" in err
        ? String((err as { code?: unknown }).code)
        : null;

    if (code === "ENOENT") {
      try {
        await fs.promises.mkdir(path.dirname(storePath), { recursive: true });
        await fs.promises.writeFile(storePath, json, "utf-8");
      } catch (err2) {
        const code2 =
          err2 && typeof err2 === "object" && "code" in err2
            ? String((err2 as { code?: unknown }).code)
            : null;
        if (code2 === "ENOENT") return;
        throw err2;
      }
      return;
    }

    throw err;
  } finally {
    await fs.promises.rm(tmp, { force: true });
  }
}

export function getOrCreateSession(
  store: Record<string, SessionEntry>,
  sessionKey: string,
): SessionEntry {
  const existing = store[sessionKey];
  if (existing) return existing;

  const newSession: SessionEntry = {
    sessionId: crypto.randomUUID(),
    updatedAt: Date.now(),
  };
  store[sessionKey] = newSession;
  return newSession;
}

export async function updateSessionUsage(params: {
  storePath: string;
  sessionKey: string;
  usage?: {
    input?: number;
    output?: number;
    total?: number;
  };
  model?: string;
  modelProvider?: string;
}) {
  const { storePath, sessionKey, usage, model, modelProvider } = params;
  const store = loadSessionStore(storePath);
  const existing = store[sessionKey];
  const now = Date.now();

  const next: SessionEntry = {
    sessionId: existing?.sessionId ?? crypto.randomUUID(),
    updatedAt: now,
    thinkingLevel: existing?.thinkingLevel,
    verboseLevel: existing?.verboseLevel,
    modelOverride: existing?.modelOverride,
    inputTokens: (existing?.inputTokens ?? 0) + (usage?.input ?? 0),
    outputTokens: (existing?.outputTokens ?? 0) + (usage?.output ?? 0),
    totalTokens: (existing?.totalTokens ?? 0) + (usage?.total ?? 0),
    modelProvider: modelProvider ?? existing?.modelProvider,
    model: model ?? existing?.model,
    contextTokens: existing?.contextTokens,
    compactionCount: existing?.compactionCount,
    displayName: existing?.displayName,
  };

  store[sessionKey] = next;
  await saveSessionStore(storePath, store);
  return next;
}
