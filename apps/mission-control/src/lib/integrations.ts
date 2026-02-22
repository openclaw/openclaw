import fs from "fs";
import os from "os";
import path from "path";

export const INTEGRATION_SERVICES = [
  // Dev tools
  "github",
  "vercel",
  "neon",
  "render",
  // Messaging channels
  "telegram",
  "whatsapp",
  "slack",
  "discord",
  "signal",
  "imessage",
  // Email
  "gmail",
  "outlook",
  // System
  "telegram_master",
] as const;

export type IntegrationService = (typeof INTEGRATION_SERVICES)[number];

interface StoredIntegration {
  token: string;
  username?: string;
  teamId?: string;
  updatedAt?: string;
}

type IntegrationStore = Partial<Record<IntegrationService, StoredIntegration>>;

export interface IntegrationSummary {
  configured: boolean;
  preview: string | null;
  username: string | null;
  teamId: string | null;
  updatedAt: string | null;
}

const INTEGRATIONS_FILE = path.join(
  os.homedir(),
  ".openclaw",
  "dashboard-integrations.json"
);

function ensureIntegrationsDir(): void {
  const dir = path.dirname(INTEGRATIONS_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function maskToken(token: string): string {
  if (!token || token.length < 12) {return "****";}
  return `${token.slice(0, 8)}...${token.slice(-4)}`;
}

export function readIntegrationsStore(): IntegrationStore {
  try {
    if (!fs.existsSync(INTEGRATIONS_FILE)) {
      return {};
    }
    const raw = JSON.parse(fs.readFileSync(INTEGRATIONS_FILE, "utf8")) as Record<
      string,
      unknown
    >;
    const out: IntegrationStore = {};
    for (const service of INTEGRATION_SERVICES) {
      const value = raw?.[service];
      if (!value || typeof value !== "object") {continue;}
      const obj = value as Record<string, unknown>;
      const token = typeof obj.token === "string" ? obj.token.trim() : "";
      if (!token) {continue;}
      out[service] = {
        token,
        username: typeof obj.username === "string" ? obj.username : undefined,
        teamId: typeof obj.teamId === "string" ? obj.teamId : undefined,
        updatedAt: typeof obj.updatedAt === "string" ? obj.updatedAt : undefined,
      };
    }
    return out;
  } catch {
    return {};
  }
}

export function writeIntegrationsStore(store: IntegrationStore): void {
  ensureIntegrationsDir();
  fs.writeFileSync(INTEGRATIONS_FILE, `${JSON.stringify(store, null, 2)}\n`, {
    mode: 0o600,
  });
}

export function listIntegrationSummaries(): Record<
  IntegrationService,
  IntegrationSummary
> {
  const store = readIntegrationsStore();
  const result = {} as Record<IntegrationService, IntegrationSummary>;

  for (const service of INTEGRATION_SERVICES) {
    const value = store[service];
    result[service] = {
      configured: !!value?.token,
      preview: value?.token ? maskToken(value.token) : null,
      username: value?.username ?? null,
      teamId: value?.teamId ?? null,
      updatedAt: value?.updatedAt ?? null,
    };
  }

  return result;
}

export function upsertIntegration(params: {
  service: IntegrationService;
  token: string;
  username?: string;
  teamId?: string;
}): void {
  const store = readIntegrationsStore();
  store[params.service] = {
    token: params.token.trim(),
    username: params.username?.trim() || undefined,
    teamId: params.teamId?.trim() || undefined,
    updatedAt: new Date().toISOString(),
  };
  writeIntegrationsStore(store);
}

export function removeIntegration(service: IntegrationService): boolean {
  const store = readIntegrationsStore();
  if (!store[service]) {return false;}
  delete store[service];
  writeIntegrationsStore(store);
  return true;
}

