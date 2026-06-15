#!/usr/bin/env node --import tsx
/**
 * Reproduction script for issue #92516:
 * "Containerized/self-hosted deploys can't use externalized channel plugins:
 *  openKeyedStore is gated to trusted plugins, with no supported way to trust a self-hosted channel."
 *
 * This script verifies that ClawHub installs from the official catalog are now trusted
 * regardless of the channel type (official/community/private), enabling self-hosted
 * deployments to use externalized channel plugins like msteams.
 *
 * Before fix: Only clawhubChannel === "official" was trusted
 * After fix: All ClawHub channels (official/community/private) are trusted when the package
 *            matches the official catalog, enabling self-hosted deployments.
 */

import { loadPluginManifestRegistry } from "../../src/plugins/manifest-registry.js";
import type { PluginCandidate } from "../../src/plugins/discovery.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

function makeTempDir(): string {
  const tempDir = fs.mkdtempSync(path.join(repoRoot, "tmp-test-"));
  return tempDir;
}

function writeManifest(dir: string, manifest: Record<string, unknown>): void {
  fs.writeFileSync(
    path.join(dir, "openclaw.plugin.json"),
    JSON.stringify(manifest),
    "utf-8"
  );
}

function createPluginCandidate(params: {
  idHint: string;
  rootDir: string;
  packageName: string;
  origin: "global" | "config" | "bundled";
}): PluginCandidate {
  return {
    id: params.idHint,
    rootDir: params.rootDir,
    packageName: params.packageName,
    origin: params.origin,
    source: path.join(params.rootDir, "openclaw.plugin.json"),
    enabled: true,
    explicitlyEnabled: true,
    status: "loaded",
    channelIds: [],
    providerIds: [],
    embeddingProviderIds: [],
    speechProviderIds: [],
    realtimeTranscriptionProviderIds: [],
    realtimeVoiceProviderIds: [],
    mediaUnderstandingProviderIds: [],
    transcriptSourceProviderIds: [],
    imageGenerationProviderIds: [],
    videoGenerationProviderIds: [],
    musicGenerationProviderIds: [],
    webFetchProviderIds: [],
    webSearchProviderIds: [],
    migrationProviderIds: [],
    memoryEmbeddingProviderIds: [],
    cliBackendIds: [],
    cliCommands: [],
    commands: [],
    services: [],
    gatewayDiscoveryServiceIds: [],
    agentHarnessIds: [],
    toolNames: [],
    hookNames: [],
    hookCount: 0,
    httpRoutes: 0,
  } as PluginCandidate;
}

async function main() {
  console.log("=== Reproduction for issue #92516 ===");
  console.log(
    "Verifying ClawHub installs from official catalog are trusted regardless of channel type\n"
  );

  const dir = makeTempDir();
  writeManifest(dir, { id: "copilot", configSchema: { type: "object" } });

  try {
    // Test with ClawHub official channel
    console.log("Testing ClawHub official channel...");
    const registryOfficial = loadPluginManifestRegistry({
      installRecords: {
        copilot: {
          source: "clawhub",
          clawhubUrl: "https://clawhub.ai",
          clawhubPackage: "@openclaw/copilot",
          clawhubChannel: "official",
          clawhubFamily: "code-plugin",
          artifactKind: "npm-pack",
          artifactFormat: "tgz",
          npmIntegrity: "sha512-official",
          installPath: dir,
          version: "1.0.0",
        },
      },
      candidates: [
        createPluginCandidate({
          idHint: "copilot",
          rootDir: dir,
          packageName: "@openclaw/copilot",
          origin: "global",
        }),
      ],
    });

    if (registryOfficial.plugins[0]?.trustedOfficialInstall !== true) {
      console.error("FAIL: Official channel should be trusted");
      process.exitCode = 1;
      return;
    }
    console.log("✓ Official channel trusted\n");

    // Test with ClawHub community channel
    console.log("Testing ClawHub community channel...");
    const registryCommunity = loadPluginManifestRegistry({
      installRecords: {
        copilot: {
          source: "clawhub",
          clawhubUrl: "https://clawhub.ai",
          clawhubPackage: "@openclaw/copilot",
          clawhubChannel: "community",
          clawhubFamily: "code-plugin",
          artifactKind: "npm-pack",
          artifactFormat: "tgz",
          npmIntegrity: "sha512-community",
          installPath: dir,
          version: "1.0.0",
        },
      },
      candidates: [
        createPluginCandidate({
          idHint: "copilot",
          rootDir: dir,
          packageName: "@openclaw/copilot",
          origin: "global",
        }),
      ],
    });

    if (registryCommunity.plugins[0]?.trustedOfficialInstall !== true) {
      console.error("FAIL: Community channel should be trusted");
      process.exitCode = 1;
      return;
    }
    console.log("✓ Community channel trusted\n");

    // Test with ClawHub private channel
    console.log("Testing ClawHub private channel...");
    const registryPrivate = loadPluginManifestRegistry({
      installRecords: {
        copilot: {
          source: "clawhub",
          clawhubUrl: "https://clawhub.ai",
          clawhubPackage: "@openclaw/copilot",
          clawhubChannel: "private",
          clawhubFamily: "code-plugin",
          artifactKind: "npm-pack",
          artifactFormat: "tgz",
          npmIntegrity: "sha512-private",
          installPath: dir,
          version: "1.0.0",
        },
      },
      candidates: [
        createPluginCandidate({
          idHint: "copilot",
          rootDir: dir,
          packageName: "@openclaw/copilot",
          origin: "global",
        }),
      ],
    });

    if (registryPrivate.plugins[0]?.trustedOfficialInstall !== true) {
      console.error("FAIL: Private channel should be trusted");
      process.exitCode = 1;
      return;
    }
    console.log("✓ Private channel trusted\n");

    console.log("PASS: All ClawHub channel types (official/community/private) are trusted.");
    console.log("\nThis fix enables self-hosted deployments to use externalized channel plugins");
    console.log("from ClawHub while maintaining trust through official catalog validation.");
    console.log("\nIssue #92516 resolution:");
    console.log("  - Before fix: Only clawhubChannel === 'official' was trusted");
    console.log("  - After fix:  All ClawHub channels (official/community/private) are trusted when the package matches the official catalog");
  } finally {
    // Cleanup
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  }
}

main().catch((err) => {
  console.error("FAIL: Unexpected error:", err);
  process.exitCode = 1;
});
