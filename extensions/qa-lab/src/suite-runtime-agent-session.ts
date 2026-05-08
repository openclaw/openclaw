import {
  createSqliteSessionTranscriptLocator,
  CURRENT_SESSION_VERSION,
  replaceSqliteSessionTranscriptEvents,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { upsertSessionEntry } from "openclaw/plugin-sdk/config-runtime";
import { createPluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { liveTurnTimeoutMs } from "./suite-runtime-agent-common.js";
import type {
  QaRawSessionEntry,
  QaSkillStatusEntry,
  QaSuiteRuntimeEnv,
} from "./suite-runtime-types.js";

type ActiveMemorySessionToggleEntry = {
  version: 1;
  disabled: true;
  updatedAt: number;
};

function createActiveMemorySessionToggleStore(env: Pick<QaSuiteRuntimeEnv, "gateway">) {
  return createPluginStateKeyedStore<ActiveMemorySessionToggleEntry>("active-memory", {
    namespace: "session-toggles",
    maxEntries: 50_000,
    env: env.gateway.runtimeEnv,
  });
}

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

async function seedQaSessionTranscript(
  env: Pick<QaSuiteRuntimeEnv, "gateway">,
  params: {
    agentId?: string;
    sessionId: string;
    sessionKey?: string;
    messages?: Array<{ role: string; content: unknown; timestamp?: number | string }>;
    now?: number;
    originLabel?: string;
    lastChannel?: string;
    lastProvider?: string;
    lastTo?: string;
    spawnedBy?: string;
    parentSessionKey?: string;
    status?: "running" | "done" | "failed" | "killed" | "timeout";
    endedAt?: number;
  },
) {
  const agentId = params.agentId?.trim() || "qa";
  const now = params.now ?? Date.now();
  const sessionId = params.sessionId.trim();
  if (!sessionId) {
    throw new Error("seedQaSessionTranscript requires sessionId");
  }
  const sessionFile = createSqliteSessionTranscriptLocator({ agentId, sessionId });
  const sessionKey = params.sessionKey?.trim() || `agent:${agentId}:seed-${sessionId}`;
  const messages = params.messages ?? [];
  let parentId: string | null = null;
  const messageEvents = messages.map((message, index) => {
    const id = `qa-seed-${index + 1}`;
    const timestampMs = now - Math.max(1, messages.length - index) * 30_000;
    const event = {
      type: "message" as const,
      id,
      parentId,
      timestamp: new Date(timestampMs).toISOString(),
      message: {
        ...message,
        timestamp:
          typeof message.timestamp === "number" || typeof message.timestamp === "string"
            ? message.timestamp
            : timestampMs,
      },
    };
    parentId = id;
    return event;
  });
  replaceSqliteSessionTranscriptEvents({
    agentId,
    sessionId,
    transcriptPath: sessionFile,
    env: env.gateway.runtimeEnv,
    events: [
      {
        type: "session",
        id: sessionId,
        version: CURRENT_SESSION_VERSION,
        timestamp: new Date(now - 120_000).toISOString(),
        cwd: env.gateway.workspaceDir,
      },
      ...messageEvents,
    ],
    now: () => now,
  });
  upsertSessionEntry({
    agentId,
    env: env.gateway.runtimeEnv,
    sessionKey,
    entry: {
      sessionId,
      updatedAt: now,
      sessionFile,
      ...(params.lastChannel ? { lastChannel: params.lastChannel } : {}),
      ...(params.lastProvider ? { lastProvider: params.lastProvider } : {}),
      ...(params.lastTo ? { lastTo: params.lastTo } : {}),
      ...(params.spawnedBy ? { spawnedBy: params.spawnedBy } : {}),
      ...(params.parentSessionKey ? { parentSessionKey: params.parentSessionKey } : {}),
      ...(params.status ? { status: params.status } : {}),
      ...(typeof params.endedAt === "number" ? { endedAt: params.endedAt } : {}),
      origin: {
        label: params.originLabel ?? "QA seeded SQLite transcript",
      },
    },
  });
  return { agentId, sessionId, sessionKey, sessionFile };
}

async function setQaActiveMemorySessionDisabled(
  env: Pick<QaSuiteRuntimeEnv, "gateway">,
  params: { sessionKey: string; disabled: boolean; now?: number },
) {
  const sessionKey = params.sessionKey.trim();
  if (!sessionKey) {
    throw new Error("setQaActiveMemorySessionDisabled requires sessionKey");
  }
  const toggleStore = createActiveMemorySessionToggleStore(env);
  if (params.disabled) {
    await toggleStore.register(sessionKey, {
      version: 1,
      disabled: true,
      updatedAt: params.now ?? Date.now(),
    });
    return { sessionKey, disabled: true };
  }
  await toggleStore.delete(sessionKey);
  return { sessionKey, disabled: false };
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

async function readRawQaSessionEntries(env: Pick<QaSuiteRuntimeEnv, "gateway">) {
  const payload = (await env.gateway.call(
    "sessions.list",
    {
      agentId: "qa",
      includeGlobal: true,
      includeUnknown: true,
      limit: 1000,
    },
    {
      timeoutMs: 45_000,
    },
  )) as {
    sessions?: Array<
      QaRawSessionEntry & {
        key?: string;
      }
    >;
  };
  return Object.fromEntries(
    (payload.sessions ?? []).flatMap((session) => {
      const key = session.key?.trim();
      if (!key) {
        return [];
      }
      return [
        [
          key,
          {
            ...(session.sessionId ? { sessionId: session.sessionId } : {}),
            ...(session.status ? { status: session.status } : {}),
            ...(session.spawnedBy ? { spawnedBy: session.spawnedBy } : {}),
            ...(session.label ? { label: session.label } : {}),
            ...(typeof session.abortedLastRun === "boolean"
              ? { abortedLastRun: session.abortedLastRun }
              : {}),
            ...(typeof session.updatedAt === "number" ? { updatedAt: session.updatedAt } : {}),
          } satisfies QaRawSessionEntry,
        ],
      ];
    }),
  );
}

export {
  createSession,
  readEffectiveTools,
  readRawQaSessionEntries,
  readSkillStatus,
  setQaActiveMemorySessionDisabled,
  seedQaSessionTranscript,
};
