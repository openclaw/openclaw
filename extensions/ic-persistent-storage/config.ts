/// Config types and parser for IC Memory Vault extension.

export interface IcStorageConfig {
  canisterId?: string;
  factoryCanisterId: string;
  network: "local" | "ic";
  autoSync: boolean;
  syncOnSessionEnd: boolean;
  syncOnAgentEnd: boolean;
}

// Default factory canister ID (deployed to IC mainnet)
const DEFAULT_FACTORY_CANISTER_ID = "v7tpn-laaaa-aaaac-bcmdq-cai";

const ALLOWED_KEYS = new Set([
  "canisterId",
  "factoryCanisterId",
  "network",
  "autoSync",
  "syncOnSessionEnd",
  "syncOnAgentEnd",
]);

function assertAllowedKeys(obj: Record<string, unknown>): void {
  for (const key of Object.keys(obj)) {
    if (!ALLOWED_KEYS.has(key)) {
      throw new Error(`Unknown config key "${key}". Allowed keys: ${[...ALLOWED_KEYS].join(", ")}`);
    }
  }
}

function resolveEnvVars(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_, envVar) => {
    return process.env[envVar] ?? "";
  });
}

export function parseConfig(value: unknown): IcStorageConfig {
  if (value === undefined || value === null) {
    return {
      factoryCanisterId: DEFAULT_FACTORY_CANISTER_ID,
      network: "ic",
      autoSync: true,
      syncOnSessionEnd: true,
      syncOnAgentEnd: true,
    };
  }

  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("IC storage config must be an object");
  }

  const raw = value as Record<string, unknown>;
  assertAllowedKeys(raw);

  const network = raw.network ?? "ic";
  if (network !== "local" && network !== "ic") {
    throw new Error(`Invalid network "${String(network)}". Must be "local" or "ic".`);
  }

  let canisterId: string | undefined;
  if (raw.canisterId != null) {
    if (typeof raw.canisterId !== "string") {
      throw new Error("canisterId must be a string");
    }
    canisterId = resolveEnvVars(raw.canisterId);
  }

  let factoryCanisterId = DEFAULT_FACTORY_CANISTER_ID;
  if (raw.factoryCanisterId != null) {
    if (typeof raw.factoryCanisterId !== "string") {
      throw new Error("factoryCanisterId must be a string");
    }
    factoryCanisterId = resolveEnvVars(raw.factoryCanisterId);
  }

  return {
    canisterId,
    factoryCanisterId,
    network: network as "local" | "ic",
    autoSync: raw.autoSync !== false,
    syncOnSessionEnd: raw.syncOnSessionEnd !== false,
    syncOnAgentEnd: raw.syncOnAgentEnd !== false,
  };
}

export const icStorageConfigSchema = {
  parse: parseConfig,
  uiHints: {
    canisterId: {
      label: "Vault Canister ID",
      placeholder: "e.g. uxrrr-q7777-77774-qaaaq-cai",
      help: "Set automatically by /vault-setup.",
    },
    factoryCanisterId: {
      label: "Factory Canister ID",
      advanced: true,
    },
    network: {
      label: "Network",
      advanced: true,
    },
    autoSync: {
      label: "Auto Sync",
    },
    syncOnSessionEnd: {
      label: "Sync on Session End",
    },
    syncOnAgentEnd: {
      label: "Sync on Agent End",
    },
  },
};
