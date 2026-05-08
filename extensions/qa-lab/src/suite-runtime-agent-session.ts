import { liveTurnTimeoutMs } from "./suite-runtime-agent-common.js";
import type {
  QaRawSessionEntry,
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

export { createSession, readEffectiveTools, readRawQaSessionEntries, readSkillStatus };
