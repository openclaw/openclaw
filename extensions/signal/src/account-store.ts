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
  try {
    const raw = await readFile(resolveSignalCliAccountsPath(params.configPath), "utf8");
    const parsed = JSON.parse(raw) as SignalCliAccountStore;
    const normalizedAccount = normalizeE164(account);
    const match = parsed.accounts?.find((entry) => {
      const number = entry?.number?.trim();
      return number ? normalizeE164(number) === normalizedAccount : false;
    });
    const uuid = match?.uuid?.trim();
    return uuid && normalizeSignalUuidForCompare(uuid) ? uuid : undefined;
  } catch {
    return undefined;
  }
}
