/**
 * Configuration resolution: merge user-provided plugin config with defaults.
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { hostname } from "node:os";
import path from "node:path";
import type { GatewayProbeConfig, ResolvedProbeConfig } from "./types.js";

const DEFAULTS = {
  probe: {
    probeId: "",
    name: "",
  },
  kafka: {
    enabled: false,
    brokers: ["127.0.0.1:9092"],
    topic: "openclaw.gateway.probe.events",
    clientId: "openclaw-gateway-probe",
    flushIntervalMs: 1000,
    batchMaxSize: 100,
    maxQueueSize: 5000,
  },
} as const;

const PROBE_ID_FILE_RELATIVE = path.join("extensions", "gateway-probe", "probe-id.json");

type ResolveConfigOptions = {
  env?: NodeJS.ProcessEnv;
  stateDir?: string;
};

type StoredProbeId = {
  version: 1;
  probeId: string;
  createdAtMs: number;
};

function toTrimmedStringArray(values?: string[]): string[] {
  return (values ?? []).map((value) => value.trim()).filter((value) => value.length > 0);
}

function parseEnvLabels(raw: string | undefined): Record<string, string> {
  if (!raw) {
    return {};
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }

    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).filter(
        ([, value]) => typeof value === "string",
      ),
    ) as Record<string, string>;
  } catch {
    return {};
  }
}

function parseEnvBrokers(raw: string | undefined): string[] {
  if (!raw) {
    return [];
  }
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function parseEnvBoolean(raw: string | undefined): boolean | undefined {
  if (!raw) {
    return undefined;
  }
  const normalized = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return undefined;
}

function resolveProbeIdPath(stateDir?: string): string | null {
  const base = stateDir?.trim();
  if (!base) {
    return null;
  }
  return path.join(base, PROBE_ID_FILE_RELATIVE);
}

function loadOrCreatePersistedProbeId(stateDir?: string): string {
  const filePath = resolveProbeIdPath(stateDir);
  if (!filePath) {
    return randomUUID();
  }

  try {
    if (fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, "utf8");
      const parsed = JSON.parse(raw) as StoredProbeId;
      if (parsed?.version === 1 && typeof parsed.probeId === "string" && parsed.probeId.trim()) {
        return parsed.probeId;
      }
    }
  } catch {
    // Ignore read/parse failures and regenerate.
  }

  const probeId = randomUUID();

  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    const stored: StoredProbeId = {
      version: 1,
      probeId,
      createdAtMs: Date.now(),
    };
    fs.writeFileSync(filePath, `${JSON.stringify(stored, null, 2)}\n`, { mode: 0o600 });
    fs.chmodSync(filePath, 0o600);
  } catch {
    // Best effort persistence; keep the generated id for the current process.
  }

  return probeId;
}

export function resolveConfig(
  raw?: Record<string, unknown>,
  options?: ResolveConfigOptions,
): ResolvedProbeConfig {
  const cfg = (raw ?? {}) as GatewayProbeConfig;
  const env = options?.env ?? process.env;

  const envProbeId = env.OPENCLAW_PROBE_ID?.trim();
  const envProbeName = env.OPENCLAW_PROBE_NAME?.trim();
  const envLabels = parseEnvLabels(env.OPENCLAW_PROBE_LABELS);
  const envKafkaEnabled = parseEnvBoolean(env.OPENCLAW_PROBE_KAFKA_ENABLED);
  const envKafkaBrokers = parseEnvBrokers(env.OPENCLAW_PROBE_KAFKA_BROKERS);
  const envKafkaTopic = env.OPENCLAW_PROBE_KAFKA_TOPIC?.trim();
  const envKafkaClientId = env.OPENCLAW_PROBE_KAFKA_CLIENT_ID?.trim();

  const probeId =
    cfg.probe?.probeId?.trim() ||
    envProbeId ||
    DEFAULTS.probe.probeId ||
    loadOrCreatePersistedProbeId(options?.stateDir);
  const name = cfg.probe?.name?.trim() || envProbeName || `probe-${hostname()}`;

  const labels: Record<string, string> = {
    "agent.type": "openclaw",
    hostname: hostname(),
    ...envLabels,
    ...(cfg.labels ?? {}),
  };

  const cfgKafkaBrokers = toTrimmedStringArray(cfg.kafka?.brokers);
  const kafkaBrokers = (cfgKafkaBrokers.length > 0 ? cfgKafkaBrokers : undefined) ??
    (envKafkaBrokers.length > 0 ? envKafkaBrokers : undefined) ?? [...DEFAULTS.kafka.brokers];

  return {
    probe: {
      probeId,
      name,
    },
    labels,
    kafka: {
      enabled: cfg.kafka?.enabled ?? envKafkaEnabled ?? DEFAULTS.kafka.enabled,
      brokers: kafkaBrokers,
      topic: cfg.kafka?.topic?.trim() || envKafkaTopic || DEFAULTS.kafka.topic,
      clientId: cfg.kafka?.clientId?.trim() || envKafkaClientId || DEFAULTS.kafka.clientId,
      flushIntervalMs: Math.max(200, cfg.kafka?.flushIntervalMs ?? DEFAULTS.kafka.flushIntervalMs),
      batchMaxSize: Math.max(1, cfg.kafka?.batchMaxSize ?? DEFAULTS.kafka.batchMaxSize),
      maxQueueSize: Math.max(100, cfg.kafka?.maxQueueSize ?? DEFAULTS.kafka.maxQueueSize),
    },
  };
}
