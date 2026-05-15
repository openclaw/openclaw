import fs from "node:fs/promises";
import path from "node:path";
import { summarizeRuntimeTranscript } from "./runtime-transcript.js";
import { liveTurnTimeoutMs } from "./suite-runtime-agent-common.js";
import type {
  QaRawSessionStoreEntry,
  QaSkillStatusEntry,
  QaSuiteRuntimeEnv,
} from "./suite-runtime-types.js";

async function createSession(
  env: Pick<QaSuiteRuntimeEnv, "gateway" | "primaryModel" | "alternateModel" | "providerMode">,
  label: string,
  key?: string,
) {
  const created = (await env.gateway.call(
    "sessions.create",
    {
      label,
      ...(key ? { key } : {}),
    },
    {
      timeoutMs: liveTurnTimeoutMs(env, 60_000),
    },
  )) as { key?: string };
  const sessionKey = created.key?.trim();
  if (!sessionKey) {
    throw new Error("sessions.create returned no key");
  }
  return sessionKey;
}

async function readEffectiveTools(
  env: Pick<QaSuiteRuntimeEnv, "gateway" | "primaryModel" | "alternateModel" | "providerMode">,
  sessionKey: string,
) {
  const payload = (await env.gateway.call(
    "tools.effective",
    {
      sessionKey,
    },
    {
      timeoutMs: liveTurnTimeoutMs(env, 90_000),
    },
  )) as {
    groups?: Array<{ tools?: Array<{ id?: string }> }>;
  };
  const ids = new Set<string>();
  for (const group of payload.groups ?? []) {
    for (const tool of group.tools ?? []) {
      if (tool.id?.trim()) {
        ids.add(tool.id.trim());
      }
    }
  }
  return ids;
}

async function readSkillStatus(
  env: Pick<QaSuiteRuntimeEnv, "gateway" | "primaryModel" | "alternateModel" | "providerMode">,
  agentId = "qa",
) {
  const payload = (await env.gateway.call(
    "skills.status",
    {
      agentId,
    },
    {
      timeoutMs: liveTurnTimeoutMs(env, 45_000),
    },
  )) as {
    skills?: QaSkillStatusEntry[];
  };
  return payload.skills ?? [];
}

async function readRawQaSessionStore(env: Pick<QaSuiteRuntimeEnv, "gateway">) {
  const storePath = path.join(
    env.gateway.tempRoot,
    "state",
    "agents",
    "qa",
    "sessions",
    "sessions.json",
  );
  try {
    const raw = await fs.readFile(storePath, "utf8");
    return JSON.parse(raw) as Record<string, QaRawSessionStoreEntry>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

function resolveSessionTranscriptFile(params: {
  sessionsDir: string;
  sessionId: string;
  sessionEntry?: QaRawSessionStoreEntry;
}) {
  const explicitSessionFile = params.sessionEntry?.sessionFile?.trim();
  if (explicitSessionFile) {
    return path.isAbsolute(explicitSessionFile)
      ? explicitSessionFile
      : path.join(params.sessionsDir, explicitSessionFile);
  }
  return path.join(params.sessionsDir, `${params.sessionId}.jsonl`);
}

async function readSessionTranscriptSummary(
  env: Pick<QaSuiteRuntimeEnv, "gateway">,
  sessionKey: string,
) {
  const sessionsDir = path.join(env.gateway.tempRoot, "state", "agents", "qa", "sessions");
  const store = await readRawQaSessionStore(env);
  const entry =
    store[sessionKey] ??
    Object.values(store).find(
      (candidate) => candidate.sessionId === sessionKey || candidate.label === sessionKey,
    );
  const sessionId = entry?.sessionId?.trim();
  if (!sessionId) {
    return summarizeRuntimeTranscript("");
  }
  try {
    const transcript = await fs.readFile(
      resolveSessionTranscriptFile({
        sessionsDir,
        sessionId,
        sessionEntry: entry,
      }),
      "utf8",
    );
    return summarizeRuntimeTranscript(transcript);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return summarizeRuntimeTranscript("");
    }
    throw error;
  }
}

export {
  createSession,
  readEffectiveTools,
  readRawQaSessionStore,
  readSessionTranscriptSummary,
  readSkillStatus,
};
