import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import type { ChannelDoctorConfigMutation } from "openclaw/plugin-sdk/channel-contract";
import { readChannelAllowFromStore } from "openclaw/plugin-sdk/channel-pairing";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { normalizeUniqueStringEntries } from "openclaw/plugin-sdk/string-coerce-runtime";

async function applyGroupAllowFromFromStore(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  changes: string[];
}): Promise<OpenClawConfig> {
  const next = structuredClone(params.cfg ?? {});
  const section = next.channels?.whatsapp as Record<string, unknown> | undefined;
  if (!section || typeof section !== "object") {
    return params.cfg;
  }

  let changed = false;
  const maybeApply = async (prefix: string, holder: Record<string, unknown>, accountId: string) => {
    if (holder.groupPolicy !== "open") {
      return;
    }
    const allowFrom = Array.isArray(holder.allowFrom) ? holder.allowFrom : [];
    const groupAllowFrom = Array.isArray(holder.groupAllowFrom) ? holder.groupAllowFrom : [];
    if (allowFrom.length > 0 || groupAllowFrom.length > 0) {
      return;
    }
    const fromStore = await readChannelAllowFromStore(
      "whatsapp",
      params.env,
      normalizeAccountId(accountId),
    ).catch(() => []);
    const storeAllowFrom = normalizeUniqueStringEntries(fromStore);
    if (storeAllowFrom.length === 0) {
      return;
    }
    holder.groupAllowFrom = storeAllowFrom;
    params.changes.push(`${prefix}groupAllowFrom=pairing-store`);
    changed = true;
  };

  await maybeApply("channels.whatsapp.", section, DEFAULT_ACCOUNT_ID);

  const accounts = section.accounts;
  if (accounts && typeof accounts === "object") {
    for (const [accountId, accountValue] of Object.entries(accounts)) {
      if (!accountValue || typeof accountValue !== "object") {
        continue;
      }
      await maybeApply(
        `channels.whatsapp.accounts.${accountId}.`,
        accountValue as Record<string, unknown>,
        accountId,
      );
    }
  }

  return changed ? next : params.cfg;
}

export async function applyWhatsAppSecurityConfigFixes(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
}): Promise<ChannelDoctorConfigMutation> {
  const changes: string[] = [];
  const config = await applyGroupAllowFromFromStore({
    cfg: params.cfg,
    env: params.env,
    changes,
  });
  return { config, changes };
}
