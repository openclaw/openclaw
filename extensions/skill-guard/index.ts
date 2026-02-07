/**
 * Skill Guard Extension — entry point.
 *
 * Registers a load-guard that verifies skills against a trusted store manifest
 * (SHA256 full-directory check) and scans sideloaded skills with the built-in
 * static scanner.
 *
 * Configuration is read from `config.skills.guard` (NOT pluginConfig).
 */

import fs from "node:fs";
import path from "node:path";
import type { OpenClawPluginApi } from "../../src/plugins/types.js";
import { registerSkillLoadGuard } from "../../src/agents/skills/load-guard.js";
import { scanSource, isScannable } from "../../src/security/skill-scanner.js";
import { AuditLogger } from "./src/audit-logger.js";
import { CloudClient } from "./src/cloud-client.js";
import { HashCache } from "./src/hash-cache.js";
import { VerifyEngine, listAllFiles } from "./src/verify-engine.js";

export default function register(api: OpenClawPluginApi) {
  const guardConfig = api.config.skills?.guard;

  // If guard section is absent or explicitly disabled → do nothing.
  if (!guardConfig || guardConfig.enabled === false) {
    return;
  }

  const stateDir = api.runtime.state.resolveStateDir();
  const cachePath = path.join(stateDir, "security", "skill-guard", "manifest-cache.json");
  const auditPath = path.join(stateDir, "security", "skill-guard", "audit.jsonl");

  const stores = guardConfig.trustedStores ?? [];
  const sideloadPolicy = guardConfig.sideloadPolicy ?? "block-critical";
  const syncInterval = (guardConfig.syncIntervalSeconds ?? 300) * 1000;
  const auditEnabled = guardConfig.auditLog !== false;

  const audit = new AuditLogger(auditPath, auditEnabled);
  const cache = new HashCache(cachePath);
  const cloud = stores.length > 0 ? new CloudClient({ stores }) : null;

  const engine = new VerifyEngine({
    cache,
    audit,
    sideloadPolicy,
    scanDirSync: syncScanDirectory,
  });

  // ── 1. Register load guard ──
  const unregister = registerSkillLoadGuard({
    evaluate: (skills) => engine.evaluate(skills),
  });

  // ── 2. Register background sync service ──
  api.registerService({
    id: "skill-guard-sync",

    async start(ctx) {
      audit.init();
      cache.loadFromDisk();

      // Initial sync
      if (cloud) {
        await doSync(cloud, cache, audit);
      }

      // Periodic sync
      if (cloud && syncInterval > 0) {
        const timer = setInterval(() => {
          doSync(cloud!, cache, audit).catch(() => {
            // Silent — audit logger already records failures.
          });
        }, syncInterval);
        // Allow the process to exit even if the timer is pending.
        if (typeof timer === "object" && "unref" in timer) {
          timer.unref();
        }
      }
    },

    async stop() {
      unregister();
      audit.close();
    },
  });
}

// ── helpers ────────────────────────────────────────────────

async function doSync(cloud: CloudClient, cache: HashCache, audit: AuditLogger): Promise<void> {
  try {
    const manifest = await cloud.fetchManifest(cache.getVersion());
    if (manifest) {
      cache.update(manifest);
      audit.record({ event: "config_sync", detail: `version=${manifest.store.version}` });
    }
    // null = 304 not modified — cache stays as-is.
  } catch (err) {
    audit.record({
      event: "config_sync_failed",
      detail: err instanceof Error ? err.message : String(err),
    });
    if (cache.hasData()) {
      audit.record({ event: "cache_fallback" });
    }
    // Degrade gracefully: keep using whatever cache we have.
  }
}

/**
 * Synchronous directory scan using the built-in skill-scanner.
 * Reads every scannable file and runs `scanSource()`.
 */
function syncScanDirectory(baseDir: string): {
  critical: number;
  warn: number;
  detail: string;
} {
  let critical = 0;
  let warn = 0;
  const details: string[] = [];

  const files = listAllFiles(baseDir);
  for (const relPath of files) {
    const fullPath = path.join(baseDir, ...relPath.split("/"));
    if (!isScannable(fullPath)) continue;

    let source: string;
    try {
      source = fs.readFileSync(fullPath, "utf-8");
    } catch {
      continue;
    }

    const findings = scanSource(source, relPath);
    for (const f of findings) {
      if (f.severity === "critical") {
        critical++;
        details.push(`${f.ruleId} in ${relPath}`);
      } else if (f.severity === "warn") {
        warn++;
      }
    }
  }

  return {
    critical,
    warn,
    detail: details.length > 0 ? details.join(", ") : "clean",
  };
}
