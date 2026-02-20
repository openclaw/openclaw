/**
 * BitNet Guard - OpenClaw Plugin
 * Intercepts messages and screens them through BitNet before processing
 *
 * Config options (via openclaw.json plugins.entries.bitnet-guard.config):
 *   failMode: 'closed' | 'open'  - Block or allow on errors (default: closed)
 *   safelistUserIds: ['id1', 'id2'] - User IDs that bypass guard
 *   logOnly: true | false - Log only, don't block
 */

const { guardCheck, DESTRUCTIVE_COMMAND_PATTERNS } = require("./guard-core.cjs");

let pluginConfig = {
  enabled: true,
  blockOnSuspicious: true,
  logOnly: false,
  failMode: "closed",
  safelistUserIds: ["8145172607"],
};

// Track blocked messages for reporting
const blockedMessages = [];
const stats = {
  total: 0,
  passed: 0,
  blocked: 0,
  safelisted: 0,
  errors: 0,
};

let safelistSet = new Set(pluginConfig.safelistUserIds.map(String));

// Main plugin register function (required by OpenClaw)
module.exports = function register(api) {
  console.log("[bitnet-guard] ════════════════════════════════════════");
  console.log("[bitnet-guard] Registering plugin...");

  // Get config if available
  if (api.config) {
    pluginConfig = { ...pluginConfig, ...api.config };
    safelistSet = new Set((pluginConfig.safelistUserIds || []).map(String));
  }

  // Register the message_received hook
  api.on("message_received", async (event) => {
    if (!pluginConfig.enabled) return;

    stats.total++;
    const { content, from, userId, senderId } = event;
    const uid = String(userId || senderId || from || "");

    // Skip empty messages
    if (!content || content.trim().length === 0) return;

    // Safelist bypass
    if (uid && safelistSet.has(uid)) {
      stats.safelisted++;
      console.log(`[bitnet-guard] SAFELISTED user ${uid}, bypassing guard`);
      return;
    }

    console.log(`[bitnet-guard] Checking (user ${uid || "unknown"}): "${content.slice(0, 50)}..."`);

    try {
      const result = await guardCheck(content);

      if (!result.allowed) {
        stats.blocked++;
        console.warn(`[bitnet-guard] BLOCKED (${result.level}): ${result.reason}`);

        blockedMessages.push({
          timestamp: new Date().toISOString(),
          from: uid,
          content: content.slice(0, 200),
          reason: result.reason,
          level: result.level,
        });

        if (!pluginConfig.logOnly && pluginConfig.blockOnSuspicious) {
          const err = new Error(`[GUARD] Message blocked: ${result.reason}`);
          err.code = "GUARD_BLOCKED";
          throw err;
        }
      } else {
        stats.passed++;
        console.log(`[bitnet-guard] PASSED`);
      }
    } catch (err) {
      if (err.code === "GUARD_BLOCKED" || (err.message && err.message.startsWith("[GUARD]"))) {
        throw err;
      }

      stats.errors++;
      console.error("[bitnet-guard] Error during check:", err.message);

      if (pluginConfig.failMode === "closed") {
        console.warn("[bitnet-guard] BLOCKED (fail-closed): Guard error");
        const guardErr = new Error("[GUARD] Check failed (fail-closed)");
        guardErr.code = "GUARD_BLOCKED";
        throw guardErr;
      }

      console.warn("[bitnet-guard] ALLOWING (fail-open): Guard error");
    }
  });

  console.log("[bitnet-guard] Mode:", pluginConfig.logOnly ? "LOG_ONLY" : "BLOCKING");
  console.log("[bitnet-guard] Fail mode:", pluginConfig.failMode.toUpperCase());
  console.log("[bitnet-guard] Safelist:", [...safelistSet].join(", ") || "none");
  console.log("[bitnet-guard] Command patterns:", DESTRUCTIVE_COMMAND_PATTERNS.length);
  console.log("[bitnet-guard] ════════════════════════════════════════");
};

module.exports.default = module.exports;
