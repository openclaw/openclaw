#!/usr/bin/env node
/* eslint-disable no-console */
import { performance } from "node:perf_hooks";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { createConfigIO } from "../src/config/io.ts";
import { callGateway } from "../src/gateway/call.ts";
import { applyPatch } from "../src/agents/apply-patch.ts";

type Target = {
  name: "stable" | "guardian";
  label: string;
  port: number;
  configPath: string;
  stateDir: string;
};

type ActionResult = {
  target: string;
  action: string;
  ok: boolean;
  ms: number;
  error?: string;
};

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const home = os.homedir();

const parseNumber = (raw: string | undefined, fallback: number) => {
  if (!raw) {
    return fallback;
  }
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
};

const MAX_OVERHEAD_MS = Math.max(
  0,
  Math.floor(parseNumber(process.env.GUARDIAN_MAX_OVERHEAD_MS, 200)),
);
const MAX_OVERHEAD_PCT = Math.max(0, parseNumber(process.env.GUARDIAN_MAX_OVERHEAD_PCT, 0.3));
const AUDIT_BASE_DIR =
  process.env.GUARDIAN_VALIDATE_AUDIT_DIR?.trim() || os.tmpdir();

const targets: Target[] = [
  {
    name: "stable",
    label: "Stable",
    port: 18789,
    configPath: path.join(home, ".openclaw", "openclaw.json"),
    stateDir: path.join(home, ".openclaw"),
  },
  {
    name: "guardian",
    label: "Guardian",
    port: 19001,
    configPath: path.join(home, ".openclaw-guardian", "openclaw.json"),
    stateDir: path.join(home, ".openclaw-guardian"),
  },
];

const quietLogger = {
  error: () => {},
  warn: () => {},
};

const formatMs = (ms: number) => `${Math.round(ms)}ms`;

const setEnv = (overrides: Record<string, string | undefined>) => {
  const prev: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(overrides)) {
    prev[key] = process.env[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  return () => {
    for (const [key, value] of Object.entries(prev)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  };
};

const withEnv = async <T>(overrides: Record<string, string | undefined>, fn: () => Promise<T>) => {
  const restore = setEnv(overrides);
  try {
    return await fn();
  } finally {
    restore();
  }
};

const readStat = async (filePath: string) => {
  const stat = await fs.stat(filePath);
  return { mtimeMs: stat.mtimeMs, size: stat.size };
};

const runAction = async (target: Target, action: string, fn: () => Promise<void>) => {
  const start = performance.now();
  let ok = false;
  let error: string | undefined;
  try {
    await fn();
    ok = true;
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }
  const ms = performance.now() - start;
  const status = ok ? "ok" : "error";
  const detail = error ? ` - ${error}` : "";
  console.log(`[${target.label}] ${action}: ${status} ${formatMs(ms)}${detail}`);
  return { target: target.name, action, ok, ms, error } satisfies ActionResult;
};

const loadTargetConfig = (target: Target) => {
  const env = {
    ...process.env,
    OPENCLAW_CONFIG_PATH: target.configPath,
    OPENCLAW_STATE_DIR: target.stateDir,
  };
  const io = createConfigIO({
    env,
    configPath: target.configPath,
    logger: quietLogger,
  });
  const config = io.loadConfig();
  const gateway = {
    ...(config.gateway ?? {}),
    mode: "local",
    port: target.port,
  };
  return {
    config: { ...config, gateway },
    env,
  };
};

const targetEnvOverrides = (
  target: Target,
  config: { gateway?: { auth?: { token?: string; password?: string } } },
) => {
  const token = config.gateway?.auth?.token?.trim();
  const password = config.gateway?.auth?.password?.trim();
  return {
    OPENCLAW_STATE_DIR: target.stateDir,
    OPENCLAW_CONFIG_PATH: target.configPath,
    OPENCLAW_GATEWAY_PORT: String(target.port),
    OPENCLAW_GATEWAY_TOKEN: token || undefined,
    OPENCLAW_GATEWAY_PASSWORD: password || undefined,
  };
};

const ensureFile = async (filePath: string, content: string) => {
  if (!fsSync.existsSync(filePath)) {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content, "utf8");
  }
};

const AUDIT_RETRY_ATTEMPTS = 5;
const AUDIT_RETRY_DELAY_MS = 150;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const findAuditEntry = async (auditLogPath: string, targetPath: string) => {
  const lines = (await fs.readFile(auditLogPath, "utf8"))
    .split(/\r?\n/)
    .filter(Boolean);
  return lines
    .reverse()
    .map((line) => {
      try {
        return JSON.parse(line) as { action_type?: string; target?: string };
      } catch {
        return null;
      }
    })
    .find((entry) => entry?.action_type === "write" && entry?.target === targetPath);
};

const waitForAuditEntry = async (auditLogPath: string, targetPath: string) => {
  for (let attempt = 0; attempt < AUDIT_RETRY_ATTEMPTS; attempt += 1) {
    if (attempt > 0) {
      await sleep(AUDIT_RETRY_DELAY_MS);
    }
    if (!fsSync.existsSync(auditLogPath)) {
      continue;
    }
    const match = await findAuditEntry(auditLogPath, targetPath);
    if (match) {
      return true;
    }
  }
  return false;
};

const run = async () => {
  console.log("Guardian validation: starting.");

  const configStatsBefore: Record<string, { mtimeMs: number; size: number }> = {};
  for (const target of targets) {
    if (!fsSync.existsSync(target.configPath)) {
      throw new Error(`Missing config for ${target.label}: ${target.configPath}`);
    }
    configStatsBefore[target.name] = await readStat(target.configPath);
  }

  const results: ActionResult[] = [];
  const configs: Record<string, ReturnType<typeof loadTargetConfig> | null> = {
    stable: null,
    guardian: null,
  };

  for (const target of targets) {
    const configResult = await runAction(target, "config_read", async () => {
      configs[target.name] = loadTargetConfig(target);
    });
    results.push(configResult);
    if (!configResult.ok) {
      continue;
    }

    const loaded = configs[target.name];
    if (!loaded) {
      continue;
    }

    const envOverrides = targetEnvOverrides(target, loaded.config);

    const healthResult = await runAction(target, "gateway_health", async () => {
      await withEnv(envOverrides, async () => {
        await callGateway({
          method: "health",
          config: loaded.config,
          configPath: target.configPath,
        });
      });
    });
    results.push(healthResult);

    const statusResult = await runAction(target, "gateway_status", async () => {
      await withEnv(envOverrides, async () => {
        await callGateway({
          method: "status",
          config: loaded.config,
          configPath: target.configPath,
        });
      });
    });
    results.push(statusResult);

    const presenceResult = await runAction(target, "system_presence", async () => {
      await withEnv(envOverrides, async () => {
        await callGateway({
          method: "system-presence",
          config: loaded.config,
          configPath: target.configPath,
        });
      });
    });
    results.push(presenceResult);

    const sessionsResult = await runAction(target, "sessions_list", async () => {
      await withEnv(envOverrides, async () => {
        await callGateway({
          method: "sessions.list",
          config: loaded.config,
          configPath: target.configPath,
        });
      });
    });
    results.push(sessionsResult);

    const tempReadResult = await runAction(target, "temp_read", async () => {
      const tempFile = path.join(os.tmpdir(), `openclaw-guardian-validate-${target.name}.txt`);
      await ensureFile(tempFile, `validation ${target.name}\n`);
      await fs.readFile(tempFile, "utf8");
    });
    results.push(tempReadResult);
  }

  const auditTargets: Record<string, string> = {};
  const auditChecks: Record<string, { ok: boolean; error?: string }> = {};

  for (const target of targets) {
    const cfg = configs[target.name]?.config ?? loadTargetConfig(target).config;
    const envOverrides = targetEnvOverrides(target, cfg);
    const auditAction = await runAction(target, "audit_write", async () => {
      const auditDir = path.join(AUDIT_BASE_DIR, "openclaw-guardian-audit", target.name);
      const auditTarget = path.join(auditDir, `audit-${Date.now()}.txt`);
      const patch = `*** Begin Patch\n*** Add File: ${auditTarget}\n+guardian audit test\n*** End Patch\n`;
      await withEnv(envOverrides, async () => {
        await applyPatch(patch, { cwd: repoRoot, guardian: { enabled: false } });
      });
      auditTargets[target.name] = auditTarget;
    });
    results.push(auditAction);

    const auditLogPath = path.join(target.stateDir, "logs", "guardian-audit.jsonl");
    if (!auditTargets[target.name]) {
      auditChecks[target.name] = {
        ok: false,
        error: "audit target missing",
      };
      continue;
    }
    try {
      const found = await waitForAuditEntry(auditLogPath, auditTargets[target.name]);
      auditChecks[target.name] = found
        ? { ok: true }
        : {
            ok: false,
            error: fsSync.existsSync(auditLogPath)
              ? "audit entry not found for test file"
              : `audit log missing: ${auditLogPath}`,
          };
    } catch (err) {
      auditChecks[target.name] = {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  const configStatsAfter: Record<string, { mtimeMs: number; size: number }> = {};
  for (const target of targets) {
    configStatsAfter[target.name] = await readStat(target.configPath);
  }

  console.log("");
  console.log("Comparison summary");

  const actionSet = [
    "config_read",
    "gateway_health",
    "gateway_status",
    "system_presence",
    "sessions_list",
    "temp_read",
  ];

  const byTargetAction = (targetName: string, action: string) =>
    results.find((r) => r.target === targetName && r.action === action);

  const header = ["Action", "Stable(ms)", "Guardian(ms)", "Delta(ms)", "Delta(%)", "OK"].join(" | ");
  const divider = ["---", "---", "---", "---", "---", "---"].join(" | ");
  console.log(header);
  console.log(divider);

  let overheadOk = true;
  for (const action of actionSet) {
    const stable = byTargetAction("stable", action);
    const guardianResult = byTargetAction("guardian", action);
    const stableMs = stable?.ok ? stable.ms : null;
    const guardianMs = guardianResult?.ok ? guardianResult.ms : null;
    let deltaMs: number | null = null;
    let deltaPct: number | null = null;
    let ok = "n/a";
    if (typeof stableMs === "number" && typeof guardianMs === "number") {
      deltaMs = guardianMs - stableMs;
      deltaPct = stableMs > 0 ? deltaMs / stableMs : null;
      const deltaOk =
        (deltaMs <= MAX_OVERHEAD_MS || deltaMs <= 0) &&
        (deltaPct === null || deltaPct <= MAX_OVERHEAD_PCT || deltaPct <= 0);
      if (!deltaOk) {
        overheadOk = false;
      }
      ok = deltaOk ? "ok" : "slow";
    }
    const row = [
      action,
      stableMs != null ? formatMs(stableMs) : "err",
      guardianMs != null ? formatMs(guardianMs) : "err",
      deltaMs != null ? `${Math.round(deltaMs)}ms` : "n/a",
      deltaPct != null ? `${Math.round(deltaPct * 100)}%` : "n/a",
      ok,
    ];
    console.log(row.join(" | "));
  }

  const configUnchanged: string[] = [];
  const configChanged: string[] = [];
  for (const target of targets) {
    const before = configStatsBefore[target.name];
    const after = configStatsAfter[target.name];
    const unchanged = before.mtimeMs === after.mtimeMs && before.size === after.size;
    if (unchanged) {
      configUnchanged.push(target.label);
    } else {
      configChanged.push(target.label);
    }
  }

  console.log("");
  console.log("Audit log checks");
  for (const target of targets) {
    const audit = auditChecks[target.name];
    const status = audit?.ok ? "ok" : "error";
    console.log(`${target.label}: ${status}`);
    if (!audit?.ok && audit?.error) {
      console.log(`${target.label} detail: ${audit.error}`);
    }
  }
  console.log(`Config unchanged: ${configUnchanged.join(", ") || "none"}`);
  if (configChanged.length > 0) {
    console.log(`Config changed: ${configChanged.join(", ")}`);
  }

  const anyErrors = results.some((r) => !r.ok);
  const auditOk = targets.every((t) => auditChecks[t.name]?.ok);
  const finalOk = !anyErrors && overheadOk && auditOk && configChanged.length === 0;
  console.log("");
  console.log(`Overall result: ${finalOk ? "PASS" : "FAIL"}`);

  if (!finalOk) {
    process.exitCode = 1;
  }
};

await run();
