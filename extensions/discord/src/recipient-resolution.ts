import { loadConfig, type MullusiConfig } from "mullusi/plugin-sdk/config-runtime";
import { resolveDiscordAccount } from "./accounts.js";
import { parseAndResolveDiscordTarget } from "./target-resolver.js";

type DiscordRecipient =
  | {
      kind: "user";
      id: string;
    }
  | {
      kind: "channel";
      id: string;
    };

export async function parseAndResolveRecipient(
  raw: string,
  accountId?: string,
  cfg?: MullusiConfig,
): Promise<DiscordRecipient> {
  const resolvedCfg = cfg ?? loadConfig();
  const accountInfo = resolveDiscordAccount({ cfg: resolvedCfg, accountId });
  const trimmed = raw.trim();
  const parseOptions = {
    ambiguousMessage: `Ambiguous Discord recipient "${trimmed}". Use "user:${trimmed}" for DMs or "channel:${trimmed}" for channel messages.`,
  };
  const resolved = await parseAndResolveDiscordTarget(
    raw,
    {
      cfg: resolvedCfg,
      accountId: accountInfo.accountId,
    },
    parseOptions,
  );
  return { kind: resolved.kind, id: resolved.id };
}
