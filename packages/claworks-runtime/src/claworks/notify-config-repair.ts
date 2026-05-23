import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { NotifyChannelTarget } from "./notify-types.js";
import { defaultClaworksStateDir } from "./product-config-repair.js";
import { extractOwnerFromMd } from "./robot-identity.js";

function pickAllowFromEntry(allowFrom: unknown): string | undefined {
  if (!Array.isArray(allowFrom)) {
    return undefined;
  }
  for (const entry of allowFrom) {
    const value = String(entry ?? "").trim();
    if (!value || value === "*") {
      continue;
    }
    return value;
  }
  return undefined;
}

function deriveFeishuTarget(channels: Record<string, unknown> | undefined): string | undefined {
  const feishu = channels?.feishu as Record<string, unknown> | undefined;
  if (!feishu) {
    return undefined;
  }
  const top = pickAllowFromEntry(feishu.allowFrom);
  if (top) {
    return top;
  }
  const accounts = feishu.accounts as Record<string, Record<string, unknown>> | undefined;
  if (accounts) {
    const defaultAccount =
      typeof feishu.defaultAccount === "string" ? feishu.defaultAccount : undefined;
    const ordered = defaultAccount
      ? [defaultAccount, ...Object.keys(accounts).filter((id) => id !== defaultAccount)]
      : Object.keys(accounts);
    for (const accountId of ordered) {
      const account = accounts[accountId];
      const fromAccount = pickAllowFromEntry(account?.allowFrom);
      if (fromAccount) {
        return fromAccount;
      }
    }
  }
  return undefined;
}

function deriveTelegramTarget(channels: Record<string, unknown> | undefined): string | undefined {
  const telegram = channels?.telegram as Record<string, unknown> | undefined;
  if (!telegram) {
    return undefined;
  }
  const top = pickAllowFromEntry(telegram.allowFrom);
  if (top) {
    return top;
  }
  const accounts = telegram.accounts as Record<string, Record<string, unknown>> | undefined;
  if (accounts) {
    for (const account of Object.values(accounts)) {
      const fromAccount = pickAllowFromEntry(account?.allowFrom);
      if (fromAccount) {
        return fromAccount;
      }
    }
  }
  return undefined;
}

function deriveOwnerTarget(stateDir: string): NotifyChannelTarget | undefined {
  const robotMd = join(stateDir, "robot.md");
  if (!existsSync(robotMd)) {
    return undefined;
  }
  try {
    const owner = extractOwnerFromMd(readFileSync(robotMd, "utf8"));
    if (!owner?.ownerId) {
      return undefined;
    }
    return {
      channel: owner.channelId ?? "feishu",
      to: owner.ownerId,
    };
  } catch {
    return undefined;
  }
}

/** Derive notify.targets from OpenClaw channel allowFrom + robot.md Owner. */
export function deriveNotifyTargetsFromOpenClawConfig(
  config: Record<string, unknown>,
  opts?: { stateDir?: string },
): NotifyChannelTarget[] {
  const targets: NotifyChannelTarget[] = [];
  const seen = new Set<string>();
  const push = (target: NotifyChannelTarget) => {
    const key = `${target.channel}:${target.to}`;
    if (!target.to || seen.has(key)) {
      return;
    }
    seen.add(key);
    targets.push(target);
  };

  const channels = config.channels as Record<string, unknown> | undefined;
  const feishuTo = deriveFeishuTarget(channels);
  if (feishuTo) {
    push({ channel: "feishu", to: feishuTo });
  }
  const telegramTo = deriveTelegramTarget(channels);
  if (telegramTo) {
    push({ channel: "telegram", to: telegramTo });
  }

  const ownerTarget = deriveOwnerTarget(opts?.stateDir?.trim() || defaultClaworksStateDir());
  if (ownerTarget) {
    push(ownerTarget);
  }

  return targets;
}

export function repairNotifyTargets(
  config: Record<string, unknown>,
  robotConfig: { notify?: { targets?: NotifyChannelTarget[]; default_channel?: string } },
  opts?: { stateDir?: string },
): { changed: boolean; actions: string[] } {
  const actions: string[] = [];
  robotConfig.notify ??= {};
  const existing = robotConfig.notify.targets ?? [];
  if (existing.length > 0) {
    return { changed: false, actions };
  }

  const derived = deriveNotifyTargetsFromOpenClawConfig(config, opts);
  if (derived.length === 0) {
    return { changed: false, actions };
  }

  robotConfig.notify.targets = derived;
  actions.push(`notify.targets derived: ${derived.map((t) => `${t.channel}:${t.to}`).join(", ")}`);
  if (!robotConfig.notify.default_channel) {
    robotConfig.notify.default_channel = derived[0]?.channel ?? "feishu";
    actions.push(`notify.default_channel = ${robotConfig.notify.default_channel}`);
  }
  return { changed: true, actions };
}
