#!/usr/bin/env node
/**
 * Deep-merge claworks-whitelabel.openclaw.fragment.json into openclaw.json.
 *
 * Usage:
 *   node scripts/merge-openclaw-config.mjs --public-host ai.example.com
 *   node scripts/merge-openclaw-config.mjs --public-host ai.example.com --dry-run
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const DEFAULT_FRAGMENT = join(ROOT, "claworks-whitelabel.openclaw.fragment.json");

function parseArgs(argv) {
  const out = {
    configPath:
      process.env.OPENCLAW_CONFIG_PATH ||
      join(process.env.HOME || "", ".claworks", "claworks.json"),
    fragmentPath: DEFAULT_FRAGMENT,
    publicHost: process.env.PUBLIC_HOST || "",
    claworksApiKey: process.env.CLAWORKS_API_KEY || "",
    dryRun: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dry-run") out.dryRun = true;
    else if (arg === "--config") out.configPath = argv[++i];
    else if (arg === "--fragment") out.fragmentPath = argv[++i];
    else if (arg === "--public-host") out.publicHost = argv[++i];
    else if (arg === "--claworks-api-key") out.claworksApiKey = argv[++i];
    else if (arg === "--help" || arg === "-h") {
      console.log(
        `Usage: node merge-openclaw-config.mjs [--public-host HOST] [--config PATH] [--dry-run]`,
      );
      process.exit(0);
    }
  }
  return out;
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Fragment wins; objects merge recursively; arrays replace. */
function deepMerge(base, patch) {
  if (Array.isArray(patch)) return patch.slice();
  if (!isPlainObject(patch)) return patch;
  const out = isPlainObject(base) ? { ...base } : {};
  for (const [key, value] of Object.entries(patch)) {
    if (isPlainObject(value) && isPlainObject(out[key])) out[key] = deepMerge(out[key], value);
    else out[key] = deepMerge(out[key], value);
  }
  return out;
}

function unionAllow(existing, incoming) {
  const a = Array.isArray(existing) ? existing : [];
  const b = Array.isArray(incoming) ? incoming : [];
  return [...new Set([...a, ...b])];
}

function applyPlaceholders(obj, { publicHost, claworksApiKey }) {
  const json = JSON.stringify(obj);
  if (!publicHost) {
    throw new Error("PUBLIC_HOST / --public-host is required (no scheme, e.g. ai.example.com)");
  }
  let replaced = json.replaceAll("REPLACE_PUBLIC_HOST", publicHost);
  if (claworksApiKey) {
    replaced = replaced.replaceAll("REPLACE_CLAWORKS_API_KEY_OR_REMOVE", claworksApiKey);
  } else {
    const parsed = JSON.parse(replaced);
    const apiKey = parsed?.plugins?.entries?.claworks?.config?.apiKey;
    if (apiKey === "REPLACE_CLAWORKS_API_KEY_OR_REMOVE") {
      delete parsed.plugins.entries.claworks.config.apiKey;
    }
    return parsed;
  }
  return JSON.parse(replaced);
}

function main() {
  const args = parseArgs(process.argv);
  const fragmentRaw = JSON.parse(readFileSync(args.fragmentPath, "utf8"));
  const fragment = applyPlaceholders(fragmentRaw, {
    publicHost: args.publicHost,
    claworksApiKey: args.claworksApiKey,
  });

  let existing = {};
  if (existsSync(args.configPath)) {
    existing = JSON.parse(readFileSync(args.configPath, "utf8"));
  }

  const merged = deepMerge(existing, fragment);
  if (merged.plugins) {
    merged.plugins.allow = unionAllow(existing.plugins?.allow, fragment.plugins?.allow);
  }

  const output = `${JSON.stringify(merged, null, 2)}\n`;
  if (args.dryRun) {
    process.stdout.write(output);
    return;
  }

  mkdirSync(dirname(args.configPath), { recursive: true });
  writeFileSync(args.configPath, output, "utf8");
  console.log(`Merged white-label fragment → ${args.configPath}`);
  console.log(
    `  gateway.bind=${merged.gateway?.bind}  basePath=${merged.gateway?.controlUi?.basePath}`,
  );
  console.log(`  allowedOrigins=${JSON.stringify(merged.gateway?.controlUi?.allowedOrigins)}`);
  console.log(`  diagnostics.otel.serviceName=${merged.diagnostics?.otel?.serviceName}`);
  console.log("Next:");
  console.log(
    "  1. Set gateway.auth.token (openclaw onboard or openclaw doctor --state-dir ~/.claworks)",
  );
  console.log("  2. Set channels.feishu.accounts.main.appId / appSecret");
  console.log("  3. Export white-label env vars before starting:");
  console.log("       export OPENCLAW_STATE_DIR=~/.claworks");
  console.log("       export OPENCLAW_CONFIG_PATH=~/.claworks/claworks.json");
  console.log("       export NODE_OPTIONS=--title=claworks-agent");
  console.log("       export OTEL_SERVICE_NAME=ClaWorks");
  console.log("       export OPENCLAW_ATTRIBUTION_PRODUCT_OVERRIDE=ClaWorks");
  console.log("       export OPENCLAW_ATTRIBUTION_ORIGINATOR_OVERRIDE=claworks");
  console.log("       export OPENCLAW_OPENROUTER_REFERER=https://your-domain.com");
  console.log("       export OPENCLAW_GATEWAY_USER_AGENT=ClaWorks-Gateway/1.0");
  console.log("  4. openclaw gateway restart");
  console.log("  Operator console (SSH tunnel only): ssh -L 18789:127.0.0.1:18789 user@host");
  console.log("  then open: http://localhost:18789/cw-admin/");
}

main();
