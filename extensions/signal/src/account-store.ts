import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { normalizeE164 } from "openclaw/plugin-sdk/text-utility-runtime";
import { normalizeSignalUuidForCompare } from "./normalize.js";

type SignalCliAccountStore = {
  accounts?: Array<{
    number?: string | null;
    uuid?: string | null;
  }>;
};

type SignalCliGlobalConfig = {
  dataDir?: string | null;
};

const ambiguousAccountUuid = Symbol("ambiguousAccountUuid");

function expandHome(raw: string): string {
  if (raw === "~") {
    return os.homedir();
  }
  if (raw.startsWith("~/") || raw.startsWith("~\\")) {
    return path.join(os.homedir(), raw.slice(2));
  }
  return raw;
}

export function resolveSignalCliAccountsPath(configPath?: string | null): string {
  const xdgDataHome = process.env.XDG_DATA_HOME?.trim();
  const base = configPath?.trim()
    ? expandHome(configPath.trim())
    : path.join(
        xdgDataHome ? expandHome(xdgDataHome) : path.join(os.homedir(), ".local", "share"),
        "signal-cli",
      );
  return path.join(base, "data", "accounts.json");
}

function resolveSignalCliGlobalConfigPaths(): string[] {
  const paths = ["/etc/signal-cli/config.json"];
  const envConfig = process.env.SIGNAL_CLI_CONFIG?.trim();
  if (envConfig) {
    paths.push(expandHome(envConfig));
  }
  const xdgConfigHome = process.env.XDG_CONFIG_HOME?.trim();
  paths.push(
    xdgConfigHome
      ? path.join(expandHome(xdgConfigHome), "signal-cli", "config.json")
      : path.join(os.homedir(), ".config", "signal-cli", "config.json"),
  );
  return paths;
}

async function resolveSignalCliConfiguredDataDir(params: {
  readFile: typeof fs.readFile;
}): Promise<string | undefined> {
  const merged: SignalCliGlobalConfig = {};
  for (const configPath of resolveSignalCliGlobalConfigPaths()) {
    try {
      const parsed = JSON.parse(await params.readFile(configPath, "utf8")) as SignalCliGlobalConfig;
      if (typeof parsed.dataDir === "string") {
        merged.dataDir = parsed.dataDir;
      }
    } catch {
      continue;
    }
  }
  const dataDir = merged.dataDir?.trim();
  return dataDir ? expandHome(dataDir) : undefined;
}

function normalizeSignalAccountForCompare(account?: string | null): string | undefined {
  const trimmed = account?.trim();
  if (!trimmed) {
    return undefined;
  }
  return normalizeE164(trimmed) || trimmed.toLowerCase();
}

export function resolveConfiguredSignalAccountUuid(params: {
  configuredAccount?: string | null;
  configuredAccountUuid?: string | null;
  effectiveAccount?: string | null;
  accountOverridden?: boolean;
}): string | undefined {
  const uuid = params.configuredAccountUuid?.trim().replace(/^uuid:/i, "");
  if (!normalizeSignalUuidForCompare(uuid)) {
    return undefined;
  }
  if (!params.accountOverridden) {
    return uuid;
  }
  const configuredAccount = normalizeSignalAccountForCompare(params.configuredAccount);
  const effectiveAccount = normalizeSignalAccountForCompare(params.effectiveAccount);
  return configuredAccount && effectiveAccount && configuredAccount === effectiveAccount
    ? uuid
    : undefined;
}

export async function discoverSignalAccountUuid(params: {
  account?: string | null;
  configPath?: string | null;
  readFile?: typeof fs.readFile;
}): Promise<string | undefined> {
  const account = params.account?.trim();
  if (!account) {
    return undefined;
  }
  const readFile = params.readFile ?? fs.readFile;
  const readAccountStore = async (
    accountsPath: string,
  ): Promise<typeof ambiguousAccountUuid | string | undefined> => {
    try {
      const raw = await readFile(accountsPath, "utf8");
      const parsed = JSON.parse(raw) as SignalCliAccountStore;
      const normalizedAccount = normalizeE164(account);
      const matchingUuids = new Set<string>();
      for (const entry of parsed.accounts ?? []) {
        const number = entry?.number?.trim();
        if (!number || normalizeE164(number) !== normalizedAccount) {
          continue;
        }
        const uuid = entry?.uuid?.trim();
        if (uuid && normalizeSignalUuidForCompare(uuid)) {
          matchingUuids.add(uuid);
        }
      }
      if (matchingUuids.size > 1) {
        return ambiguousAccountUuid;
      }
      return matchingUuids.size === 1 ? [...matchingUuids][0] : undefined;
    } catch {
      return undefined;
    }
  };
  const configuredDataDir = params.configPath
    ? undefined
    : await resolveSignalCliConfiguredDataDir({ readFile });
  const candidatePaths = params.configPath
    ? [resolveSignalCliAccountsPath(params.configPath)]
    : configuredDataDir
      ? [path.join(configuredDataDir, "data", "accounts.json")]
      : [resolveSignalCliAccountsPath()];
  for (const accountsPath of candidatePaths) {
    const uuid = await readAccountStore(accountsPath);
    if (uuid === ambiguousAccountUuid) {
      return undefined;
    }
    if (uuid) {
      return uuid;
    }
  }
  return undefined;
}
