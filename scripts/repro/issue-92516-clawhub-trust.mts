#!/usr/bin/env node --import tsx
/**
 * Reproduction script for issue #92516:
 * "Containerized/self-hosted deploys can't use externalized channel plugins:
 *  openKeyedStore is gated to trusted plugins, with no supported way to trust a self-hosted channel."
 *
 * This script verifies that ClawHub official-channel installs from the official catalog
 * are now trusted even for npm-only catalog entries (like Microsoft Teams), enabling
 * self-hosted deployments to use externalized channel plugins.
 *
 * Before fix: ClawHub installs were only trusted when the catalog entry had clawhubSpec
 * After fix: ClawHub official-channel installs are trusted when the package matches
 *            the official catalog, regardless of whether the entry has clawhubSpec or npmSpec
 */

import { loadPluginManifestRegistry } from "../../src/plugins/manifest-registry.js";
import type { PluginCandidate } from "../../src/plugins/discovery.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(dirname, "..");

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
    "Verifying ClawHub official-channel installs are trusted for npm-only catalog entries (like Microsoft Teams)\n"
  );

  const tempDirs: string[] = [];
  const dir = makeTempDir();
  tempDirs.push(dir);
  writeManifest(dir, { id: "msteams", configSchema: { type: "object" } });
  let dir2: string | undefined;
  let dir3: string | undefined;

  try {
    // Test with npm-only catalog entry (Microsoft Teams)
    console.log("Testing ClawHub official-channel install for npm-only catalog entry (msteams)...");
    const registryMsteams = loadPluginManifestRegistry({
      installRecords: {
        msteams: {
          source: "clawhub",
          clawhubUrl: "https://clawhub.ai",
          clawhubPackage: "@openclaw/msteams",
          clawhubChannel: "official",
          clawhubFamily: "code-plugin",
          artifactKind: "npm-pack",
          artifactFormat: "tgz",
          npmIntegrity: "sha512-msteams",
          installPath: dir,
          version: "1.0.0",
        },
      },
      candidates: [
        createPluginCandidate({
          idHint: "msteams",
          rootDir: dir,
          packageName: "@openclaw/msteams",
          origin: "global",
        }),
      ],
    });

    if (registryMsteams.plugins[0]?.trustedOfficialInstall !== true) {
      console.error("FAIL: npm-only ClawHub official install should be trusted");
      process.exitCode = 1;
      return;
    }
    console.log("✓ npm-only ClawHub official install trusted\n");

    // Test that community/private channels are NOT trusted
    console.log("Testing that ClawHub community channel is NOT trusted...");
    dir2 = makeTempDir();
    tempDirs.push(dir2);
    writeManifest(dir2, { id: "copilot", configSchema: { type: "object" } });
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
          installPath: dir2,
          version: "1.0.0",
        },
      },
      candidates: [
        createPluginCandidate({
          idHint: "copilot",
          rootDir: dir2,
          packageName: "@openclaw/copilot",
          origin: "global",
        }),
      ],
    });

    if (registryCommunity.plugins[0]?.trustedOfficialInstall !== undefined) {
      console.error("FAIL: Community channel should NOT be trusted");
      process.exitCode = 1;
      return;
    }
    console.log("✓ Community channel correctly NOT trusted\n");

    console.log("Testing that ClawHub private channel is NOT trusted...");
    dir3 = makeTempDir();
    tempDirs.push(dir3);
    writeManifest(dir3, { id: "copilot", configSchema: { type: "object" } });
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
          installPath: dir3,
          version: "1.0.0",
        },
      },
      candidates: [
        createPluginCandidate({
          idHint: "copilot",
          rootDir: dir3,
          packageName: "@openclaw/copilot",
          origin: "global",
        }),
      ],
    });

    if (registryPrivate.plugins[0]?.trustedOfficialInstall !== undefined) {
      console.error("FAIL: Private channel should NOT be trusted");
      process.exitCode = 1;
      return;
    }
    console.log("✓ Private channel correctly NOT trusted\n");

    console.log("PASS: ClawHub official-channel installs are trusted for npm-only catalog entries.");
    console.log("Community and private channels correctly remain untrusted.");
    console.log("\nThis fix enables self-hosted deployments to use npm-only ClawHub channel plugins");
    console.log("(like Microsoft Teams) while maintaining the trust boundary for non-official channels.");
    console.log("\nIssue #92516 resolution:");
    console.log("  - Before fix: ClawHub installs were only trusted when catalog entry had clawhubSpec");
    console.log("  - After fix:  ClawHub official-channel installs are trusted when package matches");
    console.log("                the official catalog, regardless of clawhubSpec vs npmSpec");
  } finally {
    // Cleanup all temp directories
    for (const tempDir of tempDirs) {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors
      }
    }
  }
}

main().catch((err: unknown) => {
  console.error("FAIL: Unexpected error:", err);
  process.exitCode = 1;
});
