import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { OpenClawPluginApi, OpenClawPluginService } from "openclaw/plugin-sdk/core";

// ─── Config ──────────────────────────────────────────────────────────────────

type VpsMonitorConfig = {
  enabled: boolean;
  host: string;
  user: string;
  keyPath: string;
  pollIntervalMinutes: number;
  dedupeTtlMinutes: number;
  telegramChatId: string;
  diskThresholdPct: number;
};

function env(name: string): string | null {
  const v = process.env[name]?.trim() ?? "";
  return v || null;
}

function envNum(name: string, fallback: number): number {
  const v = env(name);
  if (!v) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export function loadVpsMonitorConfig(api: OpenClawPluginApi): VpsMonitorConfig {
  const root = (api.pluginConfig ?? {}) as Record<string, unknown>;
  const c = ((root.vps ?? {}) as Record<string, unknown>);

  const host = String(c.host ?? env("VPS_SSH_HOST") ?? "193.108.53.179");
  const user = String(c.user ?? env("VPS_SSH_USER") ?? "ubuntu");
  const keyPath = String(c.keyPath ?? env("VPS_SSH_KEY_PATH") ?? "");
  const pollIntervalMinutes =
    (typeof c.pollIntervalMinutes === "number" ? c.pollIntervalMinutes : 0) ||
    envNum("VPS_SSH_POLL_INTERVAL_MINUTES", 5);
  const dedupeTtlMinutes =
    (typeof c.dedupeTtlMinutes === "number" ? c.dedupeTtlMinutes : 0) ||
    envNum("VPS_SSH_DEDUPE_TTL_MINUTES", 60);
  const diskThresholdPct =
    (typeof c.diskThresholdPct === "number" ? c.diskThresholdPct : 0) ||
    envNum("VPS_DISK_THRESHOLD_PCT", 85);

  const telegramChatId =
    String(c.telegramChatId ?? "") ||
    env("TELEGRAM_CHAT_ID") ||
    env("VPS_TELEGRAM_CHAT_ID") ||
    "";

  const enabled =
    c.enabled !== false &&
    Boolean(keyPath) &&
    (c.enabled === true || env("VPS_MONITOR_ENABLED") !== "false");

  return { enabled, host, user, keyPath, pollIntervalMinutes, dedupeTtlMinutes, telegramChatId, diskThresholdPct };
}

// ─── SSH ─────────────────────────────────────────────────────────────────────

function sshExec(params: {
  host: string;
  user: string;
  keyPath: string;
  command: string;
  timeoutMs?: number;
}): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const args = [
      "-i", params.keyPath,
      "-o", "StrictHostKeyChecking=no",
      "-o", "ConnectTimeout=10",
      "-o", "BatchMode=yes",
      `${params.user}@${params.host}`,
      params.command,
    ];
    execFile("ssh", args, { timeout: params.timeoutMs ?? 30_000 }, (err, stdout, stderr) => {
      if (err && !stdout.trim()) {
        reject(new Error(`${err.message}\n${stderr}`));
      } else {
        resolve({ stdout: stdout ?? "", stderr: stderr ?? "" });
      }
    });
  });
}

// ─── State ───────────────────────────────────────────────────────────────────

type VpsMonitorState = {
  version: 1;
  updatedAtMs: number;
  /** fingerprint → timestamp when first alerted */
  alertedFingerprints: Record<string, number>;
};

function emptyVpsState(): VpsMonitorState {
  return { version: 1, updatedAtMs: Date.now(), alertedFingerprints: {} };
}

async function loadVpsState(stateDir: string): Promise<VpsMonitorState> {
  try {
    const raw = await readFile(join(stateDir, "vps-state.json"), "utf8");
    const parsed = JSON.parse(raw) as VpsMonitorState;
    return parsed.version === 1 ? parsed : emptyVpsState();
  } catch {
    return emptyVpsState();
  }
}

async function saveVpsState(stateDir: string, state: VpsMonitorState): Promise<void> {
  await mkdir(stateDir, { recursive: true });
  await writeFile(join(stateDir, "vps-state.json"), JSON.stringify(state, null, 2), "utf8");
}

function pruneVpsState(state: VpsMonitorState, nowMs: number, ttlMinutes: number): VpsMonitorState {
  const maxAgeMs = ttlMinutes * 60_000;
  const kept: Record<string, number> = {};
  for (const [fp, alertedAt] of Object.entries(state.alertedFingerprints)) {
    if (nowMs - alertedAt <= maxAgeMs) kept[fp] = alertedAt;
  }
  return { ...state, alertedFingerprints: kept, updatedAtMs: nowMs };
}

function fp(data: string): string {
  return createHash("sha256").update(data).digest("hex").slice(0, 16);
}

// ─── Telegram ────────────────────────────────────────────────────────────────

async function sendTelegramAlert(params: {
  api: OpenClawPluginApi;
  chatId: string;
  text: string;
}): Promise<void> {
  const send = params.api.runtime?.channel?.telegram?.sendMessageTelegram;
  if (!send) {
    params.api.logger.warn?.("vps-monitor: telegram runtime unavailable");
    return;
  }
  await send(params.chatId, params.text.slice(0, 4096), { silent: false, textMode: "markdown" });
}

// ─── Probes ──────────────────────────────────────────────────────────────────

type VpsAlert = { fingerprint: string; text: string };

/** Fetch recent error-priority journal entries. Falls back to syslog grep. */
async function probeJournalErrors(cfg: VpsMonitorConfig, sinceMinutes: number): Promise<VpsAlert[]> {
  const cmd = [
    `journalctl -p err -n 20 --since "${sinceMinutes} minutes ago" --no-pager -o short 2>/dev/null`,
    `|| grep -iE "(error|critical|fatal|panic)" /var/log/syslog 2>/dev/null | tail -n 20`,
    `|| true`,
  ].join(" ");
  const { stdout } = await sshExec({ ...cfg, command: cmd });
  const lines = stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 15 && !l.startsWith("--") && !/^Hint:/.test(l));

  return lines.map((line) => {
    const escaped = line.replace(/[_*`[\]]/g, "\\$&");
    return {
      fingerprint: fp(line),
      text: [
        `🔴 *VPS error* \`${cfg.host}\``,
        ``,
        `\`\`\``,
        escaped.slice(0, 900),
        `\`\`\``,
      ].join("\n"),
    };
  });
}

/** List systemd units currently in failed state. */
async function probeFailedUnits(cfg: VpsMonitorConfig): Promise<VpsAlert[]> {
  const cmd = `systemctl list-units --state=failed --no-legend --plain 2>/dev/null || true`;
  const { stdout } = await sshExec({ ...cfg, command: cmd });
  const units = stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.includes("failed") || l.includes(".service"));

  if (units.length === 0) return [];

  const body = units.join("\n").slice(0, 800).replace(/[_*`[\]]/g, "\\$&");
  return [{
    fingerprint: fp(`units:${units.join(",")}`),
    text: [
      `⚠️ *Failed systemd units* on \`${cfg.host}\``,
      ``,
      `\`\`\``,
      body,
      `\`\`\``,
    ].join("\n"),
  }];
}

/** Alert when any filesystem exceeds the configured threshold. */
async function probeDiskUsage(cfg: VpsMonitorConfig): Promise<VpsAlert[]> {
  const cmd = `df --output=pcent,target 2>/dev/null | tail -n +2 || true`;
  const { stdout } = await sshExec({ ...cfg, command: cmd });
  const alerts: VpsAlert[] = [];
  for (const line of stdout.split("\n")) {
    const m = line.match(/^\s*(\d+)%\s+(.+)/);
    if (!m) continue;
    const pct = parseInt(m[1], 10);
    const mount = m[2].trim();
    if (pct < cfg.diskThresholdPct) continue;
    // Bucket to nearest 5 % so we don't re-alert every tick while slowly filling.
    alerts.push({
      fingerprint: fp(`disk:${mount}:${Math.floor(pct / 5) * 5}`),
      text: `💾 *Disk ${pct}%* on \`${cfg.host}\` (mount: \`${mount}\`)`,
    });
  }
  return alerts;
}

// ─── Service ─────────────────────────────────────────────────────────────────

export function createVpsMonitorService(api: OpenClawPluginApi): OpenClawPluginService {
  let interval: ReturnType<typeof setInterval> | null = null;
  let state: VpsMonitorState | null = null;
  let cfg: VpsMonitorConfig | null = null;

  return {
    id: "vps-monitor",
    async start(ctx) {
      cfg = loadVpsMonitorConfig(api);
      if (!cfg.enabled) {
        api.logger.info?.("vps-monitor: disabled. Set VPS_SSH_KEY_PATH to enable.");
        return;
      }
      if (!cfg.telegramChatId) {
        api.logger.warn?.("vps-monitor: TELEGRAM_CHAT_ID missing — alerts will not be sent.");
      }

      state = await loadVpsState(ctx.stateDir);
      const pollMs = Math.max(60_000, Math.round(cfg.pollIntervalMinutes * 60_000));

      const tick = async () => {
        if (!cfg || !state) return;
        const nowMs = Date.now();
        state = pruneVpsState(state, nowMs, cfg.dedupeTtlMinutes);

        const [journal, units, disk] = await Promise.allSettled([
          probeJournalErrors(cfg, cfg.pollIntervalMinutes + 1),
          probeFailedUnits(cfg),
          probeDiskUsage(cfg),
        ]);

        const alerts: VpsAlert[] = [];
        if (journal.status === "fulfilled") alerts.push(...journal.value);
        else api.logger.warn?.(`vps-monitor: journal probe: ${String((journal.reason as Error)?.message ?? journal.reason)}`);
        if (units.status === "fulfilled") alerts.push(...units.value);
        else api.logger.warn?.(`vps-monitor: units probe: ${String((units.reason as Error)?.message ?? units.reason)}`);
        if (disk.status === "fulfilled") alerts.push(...disk.value);
        else api.logger.warn?.(`vps-monitor: disk probe: ${String((disk.reason as Error)?.message ?? disk.reason)}`);

        for (const alert of alerts) {
          if (state.alertedFingerprints[alert.fingerprint]) continue;
          if (cfg.telegramChatId) {
            await sendTelegramAlert({ api, chatId: cfg.telegramChatId, text: alert.text });
          }
          state = {
            ...state,
            alertedFingerprints: { ...state.alertedFingerprints, [alert.fingerprint]: nowMs },
            updatedAtMs: nowMs,
          };
        }

        await saveVpsState(ctx.stateDir, state);
      };

      await tick().catch((err) => {
        api.logger.error?.(`vps-monitor: initial tick failed: ${String((err as Error)?.message ?? err)}`);
      });

      interval = setInterval(() => {
        tick().catch((err) => {
          api.logger.error?.(`vps-monitor: tick failed: ${String((err as Error)?.message ?? err)}`);
        });
      }, pollMs);
      interval.unref?.();

      api.logger.info?.(
        `vps-monitor: started (host=${cfg.host}, user=${cfg.user}, pollIntervalMinutes=${cfg.pollIntervalMinutes}).`,
      );
    },

    async stop(ctx) {
      if (interval) {
        clearInterval(interval);
        interval = null;
      }
      if (state) {
        await saveVpsState(ctx.stateDir, state).catch(() => undefined);
      }
      state = null;
      cfg = null;
    },
  };
}
