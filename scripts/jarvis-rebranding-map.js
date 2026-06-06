#!/usr/bin/env node

/**
 * Jarvis Comprehensive Rebranding Mapper
 * Maps all OpenClaw references to Jarvis equivalents
 * Ensures tool compatibility and feature preservation
 */

const rebrandingMap = {
  // Core naming
  "OpenClaw": "Jarvis",
  "openclaw": "jarvis",
  "@openclaw": "@jarvis",
  "OPENCLAW": "JARVIS",

  // Paths and directories
  ".openclaw": ".jarvis",
  "~/.openclaw": "~/.jarvis",
  "${HOME}/.openclaw": "${HOME}/.jarvis",

  // Config files
  "openclaw.json": "jarvis.json",
  "clawdbot.json": "jarvis.json",
  ".openclaw/openclaw.json": ".jarvis/jarvis.json",
  ".clawdbot/clawdbot.json": ".jarvis/jarvis.json",

  // Environment variables
  "OPENCLAW_": "JARVIS_",
  "OPENCLAW_HOME": "JARVIS_HOME",
  "OPENCLAW_CONFIG_PATH": "JARVIS_CONFIG_PATH",
  "OPENCLAW_STATE_DIR": "JARVIS_STATE_DIR",

  // Package names
  "@openclaw/acpx": "@jarvis/acpx",
  "@openclaw/plugin-sdk": "@jarvis/plugin-sdk",
  "@openclaw/admin-http-rpc": "@jarvis/admin-http-rpc",
  "@openclaw/alibaba-provider": "@jarvis/alibaba-provider",

  // CLI commands
  "openclaw onboard": "jarvis onboard",
  "openclaw gateway": "jarvis gateway",
  "openclaw agent": "jarvis agent",
  "openclaw message": "jarvis message",
  "openclaw nodes": "jarvis nodes",
  "openclaw browser": "jarvis browser",
  "openclaw secrets": "jarvis secrets",
  "openclaw doctor": "jarvis doctor",
  "openclaw pairing": "jarvis pairing",
  "openclaw devices": "jarvis devices",
  "openclaw update": "jarvis update",

  // Logging and events
  "[openclaw]": "[jarvis]",
  "openclaw:": "jarvis:",
  "OpenClaw Gateway": "Jarvis Gateway",
  "OpenClaw Agent": "Jarvis Agent",
  "OpenClaw WebSocket": "Jarvis WebSocket",

  // Port references (keep these if needed, but note for review)
  "18789": "18789", // Default port - keep same for now

  // API and protocol
  "ACP": "ACP", // Keep - Agent Client Protocol
  "MCP": "MCP", // Keep - Model Context Protocol

  // Tool preservation markers
  "browser tool": "browser tool", // Preserve
  "canvas tool": "canvas tool", // Preserve
  "sessions tool": "sessions tool", // Preserve
  "cron tool": "cron tool", // Preserve
  "nodes tool": "nodes tool", // Preserve
};

// Files to safely skip
const skipPatterns = [
  /\.git\//,
  /node_modules\//,
  /dist\//,
  /\.env\.local/,
  /build-info\.json/,
  /package-lock\.json/,
  /pnpm-lock\.yaml/,
  /npm-shrinkwrap\.json/,
];

// File extensions to process
const processableExtensions = [
  ".ts",
  ".tsx",
  ".js",
  ".mjs",
  ".cjs",
  ".json",
  ".md",
  ".yaml",
  ".yml",
  ".toml",
  ".sh",
  ".env",
  ".example",
];

// Critical files that need extra care
const criticalFiles = [
  "package.json",
  "README.md",
  "AGENTS.md",
  "openclaw.mjs",
  ".crabbox.yaml",
  ".env.example",
];

// Tools to verify remain functional
const toolsToVerify = [
  "browser",
  "canvas",
  "sessions",
  "cron",
  "nodes",
  "read",
  "write",
  "edit",
  "process",
];

// Extensions that need updating
const extensionsToUpdate = [
  "acpx",
  "admin-http-rpc",
  "alibaba",
  // ... add others from extensions/ folder
];

module.exports = {
  rebrandingMap,
  skipPatterns,
  processableExtensions,
  criticalFiles,
  toolsToVerify,
  extensionsToUpdate,

  /**
   * Get safe replacement for a text
   */
  getSafeReplacement(originalText) {
    return rebrandingMap[originalText] || originalText;
  },

  /**
   * Check if file should be processed
   */
  shouldProcessFile(filePath) {
    // Skip patterns
    if (skipPatterns.some(pattern => pattern.test(filePath))) {
      return false;
    }

    // Check extension
    return processableExtensions.some(ext => filePath.endsWith(ext));
  },

  /**
   * Check if file is critical and needs review
   */
  isCriticalFile(filePath) {
    return criticalFiles.some(name => filePath.includes(name));
  },

  /**
   * Get rebranding statistics
   */
  getStats() {
    return {
      totalMappings: Object.keys(rebrandingMap).length,
      skipPatterns: skipPatterns.length,
      processableExtensions: processableExtensions.length,
      criticalFiles: criticalFiles.length,
      toolsToVerify: toolsToVerify.length,
      extensionsToUpdate: extensionsToUpdate.length,
    };
  },
};

if (require.main === module) {
  console.log("📊 Jarvis Rebranding Map Statistics:");
  console.log(JSON.stringify(module.exports.getStats(), null, 2));
}
