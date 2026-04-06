import { readFileSync } from "node:fs";
import type { CoreConfig, EmailAccountConfig } from "./types.js";

export const DEFAULT_ACCOUNT_ID = "default";

export type ResolvedEmailAccount = {
  accountId: string;
  name: string;
  enabled: boolean;
  configured: boolean;
  imapHost: string;
  imapPort: number;
  imapUsername: string;
  imapPassword: string;
  imapMailbox: string;
  imapUseSsl: boolean;
  smtpHost: string;
  smtpPort: number;
  smtpUsername: string;
  smtpPassword: string;
  smtpUseTls: boolean;
  smtpUseSsl: boolean;
  fromAddress: string;
  autoReplyEnabled: boolean;
  consentGranted: boolean;
  pollIntervalSeconds: number;
  markSeen: boolean;
  maxBodyChars: number;
  subjectPrefix: string;
  allowFrom: string[];
  dmPolicy: string;
  config: EmailAccountConfig;
};

function resolvePasswordSync(
  direct: string | undefined,
  _file: string | undefined,
): string {
  return direct ?? "";
}

function buildResolvedAccount(
  accountId: string,
  cfg: EmailAccountConfig,
): ResolvedEmailAccount {
  const imapHost = cfg.imapHost ?? "";
  const imapUsername = cfg.imapUsername ?? "";
  const imapPassword = resolvePasswordSync(cfg.imapPassword, cfg.imapPasswordFile);
  const smtpHost = cfg.smtpHost ?? "";
  const smtpUsername = cfg.smtpUsername ?? "";
  const smtpPassword = resolvePasswordSync(cfg.smtpPassword, cfg.smtpPasswordFile);

  const configured =
    Boolean(imapHost) && Boolean(imapUsername) && Boolean(imapPassword);

  return {
    accountId,
    name: cfg.name ?? accountId,
    enabled: cfg.enabled !== false,
    configured,
    imapHost,
    imapPort: cfg.imapPort ?? 993,
    imapUsername,
    imapPassword,
    imapMailbox: cfg.imapMailbox ?? "INBOX",
    imapUseSsl: cfg.imapUseSsl !== false,
    smtpHost,
    smtpPort: cfg.smtpPort ?? 587,
    smtpUsername,
    smtpPassword,
    smtpUseTls: cfg.smtpUseTls !== false,
    smtpUseSsl: cfg.smtpUseSsl === true,
    fromAddress:
      cfg.fromAddress ?? cfg.smtpUsername ?? cfg.imapUsername ?? "",
    autoReplyEnabled: cfg.autoReplyEnabled === true,
    consentGranted: cfg.consentGranted === true,
    pollIntervalSeconds: cfg.pollIntervalSeconds ?? 30,
    markSeen: cfg.markSeen !== false,
    maxBodyChars: cfg.maxBodyChars ?? 12000,
    subjectPrefix: cfg.subjectPrefix ?? "Re: ",
    allowFrom: cfg.allowFrom ?? ["*"],
    dmPolicy: cfg.dmPolicy ?? "allowlist",
    config: cfg,
  };
}

export function resolveEmailAccount(params: {
  cfg: CoreConfig;
  accountId?: string | null;
}): ResolvedEmailAccount {
  const section = params.cfg.channels?.email;
  if (!section) {
    return buildResolvedAccount(DEFAULT_ACCOUNT_ID, {});
  }
  const targetId = params.accountId ?? section.defaultAccount ?? DEFAULT_ACCOUNT_ID;
  const accountCfg =
    section.accounts?.[targetId] ?? (targetId === DEFAULT_ACCOUNT_ID ? section : {});
  return buildResolvedAccount(targetId, accountCfg as EmailAccountConfig);
}

export function listEmailAccountIds(cfg: CoreConfig): string[] {
  const section = cfg.channels?.email;
  if (!section) return [];
  const multi = Object.keys(section.accounts ?? {});
  return multi.length > 0 ? multi : [DEFAULT_ACCOUNT_ID];
}

export function resolveDefaultEmailAccountId(cfg: CoreConfig): string {
  return cfg.channels?.email?.defaultAccount ?? DEFAULT_ACCOUNT_ID;
}
