#!/usr/bin/env node
/**
 * Generate plugin capability declarations for extension manifests.
 *
 * Analyzes each extension's openclaw.plugin.json and source files to determine
 * what registration methods and runtime APIs it uses, then adds a `capabilities`
 * field to the manifest.
 *
 * Usage:
 *   node scripts/generate-plugin-capabilities.mjs          # dry run (report only)
 *   node scripts/generate-plugin-capabilities.mjs --write   # apply changes
 */

import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const EXTENSIONS_DIR = path.resolve(import.meta.dirname, "..", "extensions");
const MANIFEST_FILENAME = "openclaw.plugin.json";

// Registration methods → capability names (must match REGISTER_METHOD_CAPABILITIES in enforce.ts)
const REGISTER_METHOD_MAP = {
  registerTool: "tool",
  registerHook: "hook",
  registerHttpRoute: "httpRoute",
  registerChannel: "channel",
  registerProvider: "provider",
  registerSpeechProvider: "speechProvider",
  registerMediaUnderstandingProvider: "mediaUnderstandingProvider",
  registerImageGenerationProvider: "imageGenerationProvider",
  registerWebSearchProvider: "webSearchProvider",
  registerGatewayMethod: "gatewayMethod",
  registerCli: "cli",
  registerService: "service",
  registerInteractiveHandler: "interactive",
  registerCommand: "command",
};

// Runtime API properties → capability names (must match RUNTIME_PROPERTY_CAPABILITIES in enforce.ts)
const RUNTIME_PROPERTY_MAP = {
  config: "config.read",
  agent: "agent",
  subagent: "subagent",
  system: "system",
  media: "media",
  tts: "tts",
  stt: "stt",
  tools: "tools",
  channel: "channel",
  events: "events",
  logging: "logging",
  state: "state",
  modelAuth: "modelAuth",
};

function grepExtensionSource(extDir, pattern) {
  try {
    const result = execSync(
      `grep -rl "${pattern}" "${extDir}/src" "${extDir}/index.ts" "${extDir}/index.js" 2>/dev/null || true`,
      { encoding: "utf8", timeout: 5000 },
    );
    return result.trim().length > 0;
  } catch {
    return false;
  }
}

function analyzeExtension(extDir) {
  const manifestPath = path.join(extDir, MANIFEST_FILENAME);
  if (!fs.existsSync(manifestPath)) {
    return null;
  }

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch {
    return null;
  }

  const registerCaps = new Set();
  const runtimeCaps = new Set();

  // From manifest fields
  if (Array.isArray(manifest.channels) && manifest.channels.length > 0) {
    registerCaps.add("channel");
  }
  if (Array.isArray(manifest.providers) && manifest.providers.length > 0) {
    registerCaps.add("provider");
  }

  // Grep source for registration methods
  for (const [method, cap] of Object.entries(REGISTER_METHOD_MAP)) {
    if (registerCaps.has(cap)) {
      continue;
    }
    if (grepExtensionSource(extDir, method)) {
      registerCaps.add(cap);
    }
  }

  // Grep source for runtime API usage
  for (const [prop, cap] of Object.entries(RUNTIME_PROPERTY_MAP)) {
    // Look for runtime.prop or api.runtime.prop patterns
    if (
      grepExtensionSource(extDir, `runtime\\.${prop}`) ||
      grepExtensionSource(extDir, `\\.runtime\\.${prop}`)
    ) {
      runtimeCaps.add(cap);
    }
  }

  // Provider plugins commonly need config.read, modelAuth, and logging
  if (registerCaps.has("provider")) {
    runtimeCaps.add("config.read");
    runtimeCaps.add("modelAuth");
    runtimeCaps.add("logging");
  }

  // Channel plugins commonly need config.read, agent, channel, events, logging, state
  if (registerCaps.has("channel")) {
    runtimeCaps.add("config.read");
    runtimeCaps.add("logging");
  }

  // CLI plugins need config.read
  if (registerCaps.has("cli")) {
    runtimeCaps.add("config.read");
  }

  // Sort for deterministic output
  const register = [...registerCaps].toSorted((a, b) => a.localeCompare(b));
  const runtime = [...runtimeCaps].toSorted((a, b) => a.localeCompare(b));

  return {
    id: manifest.id,
    manifestPath,
    manifest,
    capabilities: {
      register,
      runtime,
    },
    hasExistingCapabilities: Boolean(manifest.capabilities),
  };
}

function main() {
  const writeMode = process.argv.includes("--write");
  const entries = fs.readdirSync(EXTENSIONS_DIR, { withFileTypes: true });

  let updated = 0;
  let skipped = 0;
  let total = 0;

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const extDir = path.join(EXTENSIONS_DIR, entry.name);
    const result = analyzeExtension(extDir);
    if (!result) {
      continue;
    }

    total++;

    if (result.hasExistingCapabilities) {
      skipped++;
      continue;
    }

    if (result.capabilities.register.length === 0 && result.capabilities.runtime.length === 0) {
      console.log(`  ${result.id}: no capabilities detected, skipping`);
      skipped++;
      continue;
    }

    console.log(
      `  ${result.id}: register=[${result.capabilities.register.join(", ")}] runtime=[${result.capabilities.runtime.join(", ")}]`,
    );

    if (writeMode) {
      // Add capabilities to manifest, preserving order (insert before closing brace)
      const updatedManifest = { ...result.manifest };
      updatedManifest.capabilities = result.capabilities;
      fs.writeFileSync(result.manifestPath, JSON.stringify(updatedManifest, null, 2) + "\n");
      updated++;
    } else {
      updated++;
    }
  }

  console.log(
    `\n${writeMode ? "Updated" : "Would update"}: ${updated}, skipped: ${skipped}, total: ${total}`,
  );
  if (!writeMode && updated > 0) {
    console.log("Run with --write to apply changes.");
  }
}

main();
