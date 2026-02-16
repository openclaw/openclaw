#!/usr/bin/env node
/**
 * Plugin Signing Tool
 *
 * Signs a plugin with a private key for verification during loading.
 * Usage: pnpm tsx scripts/sign-plugin.ts <plugin-path> <version>
 *
 * Environment variables:
 * - PLUGIN_SIGNING_KEY: Path to private key file (default: ./keys/plugin-signing-key.pem)
 */

import fs from "node:fs";
import path from "node:path";
import { PluginSigner } from "../src/plugins/plugin-signing.js";

// Read private key from environment or default location
const privateKeyPath = process.env.PLUGIN_SIGNING_KEY || "./keys/plugin-signing-key.pem";

// Parse command line arguments
const pluginPath = process.argv[2];
const version = process.argv[3];

if (!pluginPath || !version) {
  console.error("Usage: sign-plugin.ts <plugin-path> <version>");
  console.error("");
  console.error("Example:");
  console.error("  pnpm tsx scripts/sign-plugin.ts ./plugins/my-plugin/index.ts 1.0.0");
  console.error("");
  console.error("Environment variables:");
  console.error(
    "  PLUGIN_SIGNING_KEY - Path to private key (default: ./keys/plugin-signing-key.pem)",
  );
  process.exit(1);
}

// Check if plugin file exists
if (!fs.existsSync(pluginPath)) {
  console.error(`❌ Plugin file not found: ${pluginPath}`);
  process.exit(1);
}

// Check if private key exists
if (!fs.existsSync(privateKeyPath)) {
  console.error(`❌ Private key not found: ${privateKeyPath}`);
  console.error("");
  console.error("Generate signing keys with:");
  console.error("  bash scripts/generate-signing-keys.sh");
  process.exit(1);
}

try {
  // Read private key
  const privateKey = fs.readFileSync(privateKeyPath, "utf8");

  console.log("🔐 Signing plugin...");
  console.log(`   Plugin: ${pluginPath}`);
  console.log(`   Version: ${version}`);
  console.log(`   Key: ${privateKeyPath}`);
  console.log("");

  // Sign plugin
  const signature = PluginSigner.signPlugin(pluginPath, privateKey, version);

  // Save signature to plugin.signature.json in the same directory as the plugin
  const pluginDir = path.dirname(pluginPath);
  const signaturePath = path.join(pluginDir, "plugin.signature.json");

  fs.writeFileSync(signaturePath, JSON.stringify(signature, null, 2));

  console.log("✅ Plugin signed successfully");
  console.log(`   Signature saved to: ${signaturePath}`);
  console.log("");
  console.log("Signature details:");
  console.log(`   Algorithm: ${signature.algorithm}`);
  console.log(`   Timestamp: ${new Date(signature.timestamp).toISOString()}`);
  console.log(`   Version: ${signature.version}`);
  console.log("");
  console.log("⚠️  IMPORTANT:");
  console.log("   - Include plugin.signature.json when distributing the plugin");
  console.log("   - Keep your private key SECRET");
  console.log("   - Users need the public key to verify plugins");

  process.exit(0);
} catch (err) {
  console.error(`❌ Failed to sign plugin: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
