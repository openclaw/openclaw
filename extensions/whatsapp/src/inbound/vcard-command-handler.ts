import { updateConfig } from "openclaw/plugin-sdk/config-mutation";
import { normalizeE164 } from "../text-runtime.js";
import { parseVcard } from "../vcard.js";

export type VcardCommandResult = "added" | "removed" | "already" | "not-found" | null;

export type VcardCommandParams = {
  fromMe: boolean;
  selfChatMode: boolean;
  configWrites: boolean;
  command: string;
  quotedVcard: string | undefined;
  selfJid: string;
  remoteJid: string;
  accountId: string;
  sendMessage: (jid: string, content: { text: string }) => Promise<unknown>;
};

function readManualFrom(cfg: Record<string, unknown>, accountId: string): string[] {
  const whatsapp = (cfg as { channels?: { whatsapp?: Record<string, unknown> } }).channels
    ?.whatsapp;
  if (!whatsapp) return [];
  if (accountId !== "default") {
    const accounts = whatsapp.accounts as Record<string, unknown> | undefined;
    const acct = accounts?.[accountId] as Record<string, unknown> | undefined;
    if (Array.isArray(acct?.manualFrom)) return acct.manualFrom as string[];
  }
  return Array.isArray(whatsapp.manualFrom) ? (whatsapp.manualFrom as string[]) : [];
}

function writeManualFrom(
  cfg: Record<string, unknown>,
  accountId: string,
  next: string[],
): Record<string, unknown> {
  const channels = (cfg.channels ?? {}) as Record<string, unknown>;
  const whatsapp = (channels.whatsapp ?? {}) as Record<string, unknown>;
  if (accountId !== "default") {
    const accounts = (whatsapp.accounts ?? {}) as Record<string, unknown>;
    const acct = (accounts[accountId] ?? {}) as Record<string, unknown>;
    return {
      ...cfg,
      channels: {
        ...channels,
        whatsapp: {
          ...whatsapp,
          accounts: { ...accounts, [accountId]: { ...acct, manualFrom: next } },
        },
      },
    };
  }
  return {
    ...cfg,
    channels: { ...channels, whatsapp: { ...whatsapp, manualFrom: next } },
  };
}

export async function handleVcardCommand(params: VcardCommandParams): Promise<VcardCommandResult> {
  if (!params.selfChatMode || !params.configWrites) return null;
  if (!params.fromMe) return null;
  if (params.remoteJid !== params.selfJid) return null;
  if (!params.quotedVcard) return null;

  const cmd = params.command.trim().toLowerCase();
  if (cmd !== "add" && cmd !== "rm") return null;

  const parsed = parseVcard(params.quotedVcard);
  if (parsed.phones.length === 0) return null;

  const phone = normalizeE164(parsed.phones[0]);

  if (cmd === "add") {
    // Single updateConfig call: read and conditionally write.
    let outcome: "added" | "already" = "already";
    await updateConfig((cfg) => {
      const list = readManualFrom(cfg as Record<string, unknown>, params.accountId);
      const isPresent = list.map(normalizeE164).some((e) => e === phone);
      if (isPresent) {
        outcome = "already";
        return cfg;
      }
      outcome = "added";
      return writeManualFrom(cfg as Record<string, unknown>, params.accountId, [
        ...list,
        phone,
      ]) as never;
    });
    if (outcome === "already") {
      await params.sendMessage(params.selfJid, { text: "Already in manual list" });
      return "already";
    }
    await params.sendMessage(params.selfJid, { text: `Added ${phone} to manual list` });
    return "added";
  }

  // cmd === "rm": read first, then write only if present.
  let currentList: string[] = [];
  await updateConfig((cfg) => {
    currentList = readManualFrom(cfg as Record<string, unknown>, params.accountId).map(
      normalizeE164,
    );
    return cfg;
  });

  const isPresent = currentList.some((e) => e === phone);

  if (!isPresent) {
    await params.sendMessage(params.selfJid, { text: "Not in manual list" });
    return "not-found";
  }

  await updateConfig((cfg) => {
    const list = readManualFrom(cfg as Record<string, unknown>, params.accountId);
    const next = list.filter((e) => normalizeE164(e) !== phone);
    return writeManualFrom(cfg as Record<string, unknown>, params.accountId, next) as never;
  });
  await params.sendMessage(params.selfJid, { text: `Removed ${phone} from manual list` });
  return "removed";
}
