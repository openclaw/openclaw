import type { ClawdbotConfig } from "clawdbot/plugin-sdk";
import { checkZcaInstalled } from "./zca.js";
import { resolveZalouserAccountSync } from "./accounts.js";

export interface ZalouserStatusIssue {
  level: "error" | "warn" | "info";
  code: string;
  message: string;
  hint?: string;
}

export async function collectZalouserStatusIssues(params: {
  cfg: unknown;
  accountId?: string;
}): Promise<ZalouserStatusIssue[]> {
  const issues: ZalouserStatusIssue[] = [];

  // Check zca binary
  const zcaInstalled = await checkZcaInstalled();
  if (!zcaInstalled) {
    issues.push({
      level: "error",
      code: "ZCA_NOT_FOUND",
      message: "zca CLI not found in PATH",
      hint: "Install zca from https://zca-cli.dev or ensure it's in your PATH",
    });
    return issues;
  }

  // Check account configuration
  try {
    const account = resolveZalouserAccountSync({
      cfg: params.cfg as ClawdbotConfig,
      accountId: params.accountId,
    });

    if (!account.enabled) {
      issues.push({
        level: "warn",
        code: "ACCOUNT_DISABLED",
        message: `Account ${account.accountId} is disabled`,
      });
    }
  } catch (err) {
    issues.push({
      level: "error",
      code: "ACCOUNT_RESOLVE_FAILED",
      message: `Failed to resolve account: ${String(err)}`,
    });
  }

  return issues;
}
