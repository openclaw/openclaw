#!/usr/bin/env node

import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isScannable, scanSource, type SkillScanFinding } from "../src/skills/security/scanner.js";
import { inspectPackageTarballBytes } from "./plugin-publication-artifact.mjs";
import { isPluginTestFixturePath } from "./verify-plugin-npm-published-runtime.mts";

const MAX_ARCHIVE_BYTES = 128 * 1024 * 1024;
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_FILES = 10_000;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;

// This shrink-only inventory covers reviewed production behavior across supported
// release lines. Package-owned test and fixture paths are rejected before
// scanning and never belong in this inventory.
const REVIEWED_CRITICAL_FINDING_LIMITS = new Map<string, number>([
  ["setup:@openclaw/acpx:dangerous-exec:dist/.setup/service-<hash>.mjs", 1],
  ["dist:@openclaw/acpx:dangerous-exec:dist/mcp-proxy.mjs", 1],
  ["dist:@openclaw/acpx:dangerous-exec:dist/service-<hash>.js", 1],
  ["source:@openclaw/acpx:dangerous-exec:src/codex-auth-bridge.ts", 1],
  ["source:@openclaw/acpx:dangerous-exec:src/runtime-internals/mcp-proxy.mjs", 1],
  ["setup:@openclaw/codex:dangerous-exec:dist/.setup/dynamic-tools-<hash>.mjs", 2],
  ["setup:@openclaw/codex:dangerous-exec:dist/.setup/transport-stdio-<hash>.mjs", 3],
  ["dist:@openclaw/codex:dangerous-exec:dist/api.js", 1],
  ["dist:@openclaw/codex:dangerous-exec:dist/client-<hash>.js", 1],
  ["dist:@openclaw/codex:dangerous-exec:dist/dynamic-tools-<hash>.js", 2],
  ["dist:@openclaw/codex:dangerous-exec:dist/session-catalog-<hash>.js", 1],
  ["dist:@openclaw/codex:dangerous-exec:dist/transport-stdio-<hash>.js", 1],
  ["source:@openclaw/codex:dangerous-exec:src/app-server/managed-launcher-failure.ts", 1],
  ["source:@openclaw/codex:dangerous-exec:src/app-server/sandbox-exec-server/http.ts", 1],
  ["source:@openclaw/codex:dangerous-exec:src/app-server/sandbox-exec-server/processes.ts", 1],
  ["source:@openclaw/codex:dangerous-exec:src/app-server/sandbox-exec-server/sandbox-child.ts", 1],
  ["source:@openclaw/codex:dangerous-exec:src/app-server/transport-process-snapshot.ts", 1],
  ["source:@openclaw/codex:dangerous-exec:src/app-server/transport-stdio.ts", 1],
  ["source:@openclaw/codex:dangerous-exec:src/doctor.ts", 1],
  ["source:@openclaw/codex:dangerous-exec:src/node-cli-sessions.ts", 1],
  ["setup:@openclaw/discord:dangerous-exec:dist/.setup/receive-recovery-<hash>.mjs", 1],
  ["source:@openclaw/discord:dangerous-exec:src/voice/audio.ts", 1],
  ["dist:@openclaw/diffs:env-harvesting:dist/assets/viewer-runtime.js", 1],
  ["dist:@openclaw/diffs-language-pack:env-harvesting:dist/assets/viewer-runtime.js", 1],
  ["dist:@openclaw/facetime:dangerous-exec:dist/runtime-api.js", 1],
  ["source:@openclaw/facetime:dangerous-exec:src/audio-pump.ts", 1],
  ["dist:@openclaw/google-meet:dangerous-exec:dist/index.js", 1],
  ["source:@openclaw/google-meet:dangerous-exec:src/node-host.ts", 3],
  ["source:@openclaw/google-meet:dangerous-exec:src/realtime.ts", 2],
  ["setup:@openclaw/imessage:dangerous-exec:dist/.setup/client-<hash>.mjs", 1],
  ["source:@openclaw/imessage:dangerous-exec:src/client.ts", 1],
  ["dist:@openclaw/llama-cpp-provider:dangerous-exec:dist/index.js", 3],
  ["source:@openclaw/llama-cpp-provider:dangerous-exec:src/hardware.ts", 1],
  ["source:@openclaw/llama-cpp-provider:dangerous-exec:src/llama-server-install.ts", 1],
  ["source:@openclaw/llama-cpp-provider:dangerous-exec:src/llama-server-vc-runtime.ts", 1],
  ["source:@openclaw/matrix:dangerous-exec:src/matrix/deps.ts", 1],
  ["setup:@openclaw/memory-lancedb:dangerous-exec:dist/.setup/dist-<hash>.mjs", 1],
  ["setup:@openclaw/memory-lancedb:dynamic-code-execution:dist/.setup/dist-<hash>.mjs", 1],
  ["dist:@openclaw/mxc-sandbox:dangerous-exec:dist/index.js", 2],
  ["source:@openclaw/mxc-sandbox:dangerous-exec:src/readiness.ts", 2],
  ["setup:@openclaw/onnx:dangerous-exec:dist/.setup/worker-client-<hash>.mjs", 1],
  ["source:@openclaw/onnx:dangerous-exec:src/worker-client.ts", 1],
  ["dist:@openclaw/raft:dangerous-exec:dist/channel-plugin-api.js", 1],
  ["source:@openclaw/raft:dangerous-exec:src/gateway.ts", 1],
  ["setup:@openclaw/signal:dangerous-exec:dist/.setup/monitor-<hash>.mjs", 1],
  ["source:@openclaw/signal:dangerous-exec:src/daemon.ts", 1],
  ["setup:@openclaw/voice-call:dangerous-exec:dist/.setup/runtime-entry-<hash>.mjs", 1],
  ["dist:@openclaw/voice-call:dangerous-exec:dist/runtime-entry-<hash>.js", 1],
  ["source:@openclaw/voice-call:dangerous-exec:src/tunnel.ts", 4],
  ["source:@openclaw/voice-call:dangerous-exec:src/webhook/tailscale.ts", 1],
]);

// Vendored runtime findings are owned by dependency path instead of every plugin
// that happens to carry the same dependency. Tests, declarations, examples, and
// benchmarks are excluded before this shrink-only inventory is consulted.
const REVIEWED_DEPENDENCY_FINDING_LIMITS = new Map<string, number>([
  ["dangerous-exec:node_modules/@anthropic-ai/sdk/bin/cli", 1],
  ["dangerous-exec:node_modules/@anthropic-ai/sdk/tools/agent-toolset/node.browser.js", 1],
  ["dangerous-exec:node_modules/@anthropic-ai/sdk/tools/agent-toolset/node.browser.mjs", 1],
  ["dangerous-exec:node_modules/@anthropic-ai/sdk/tools/agent-toolset/node.js", 4],
  ["dangerous-exec:node_modules/@anthropic-ai/sdk/tools/agent-toolset/node.mjs", 5],
  ["dangerous-exec:node_modules/@clawdbot/lobster/bin/invoke.js", 1],
  ["dangerous-exec:node_modules/@clawdbot/lobster/dist/src/abortable_process.js", 3],
  ["dangerous-exec:node_modules/@matrix-org/matrix-sdk-crypto-nodejs/index.js", 1],
  ["dangerous-exec:node_modules/@microsoft/mxc-sdk/dist/diagnostic.js", 1],
  ["dangerous-exec:node_modules/@microsoft/mxc-sdk/dist/platform.js", 4],
  ["dangerous-exec:node_modules/@microsoft/mxc-sdk/dist/policy.js", 1],
  ["dangerous-exec:node_modules/@microsoft/mxc-sdk/dist/sandbox.js", 2],
  ["dangerous-exec:node_modules/@openclaw/fs-safe/dist/windows-security-command.js", 2],
  ["dangerous-exec:node_modules/@snazzah/davey/index.js", 1],
  ["dangerous-exec:node_modules/baileys/lib/Utils/messages-media.js", 1],
  ["dangerous-exec:node_modules/google-auth-library/build/src/auth/pluggable-auth-handler.js", 1],
  ["dangerous-exec:node_modules/node-addon-api/tools/check-napi.js", 1],
  ["dangerous-exec:node_modules/node-addon-api/tools/clang-format.js", 1],
  ["dangerous-exec:node_modules/node-addon-api/tools/eslint-format.js", 3],
  ["dangerous-exec:node_modules/playwright-core/lib/coreBundle.js", 3],
  ["dangerous-exec:node_modules/playwright-core/lib/utilsBundle.js", 10],
  ["dangerous-exec:node_modules/prism-media/src/core/FFmpeg.js", 2],
  ["dangerous-exec:node_modules/tokenjuice/dist/core/cli-client.js", 1],
  ["dangerous-exec:node_modules/tokenjuice/dist/core/wrap.js", 1],
  ["dangerous-exec:node_modules/tokenjuice/dist/hosts/codex/index.js", 1],
  ["dangerous-exec:node_modules/tokenjuice/dist/hosts/localcode/index.js", 2],
  ["dynamic-code-execution:node_modules/@napi-rs/wasm-runtime/dist/fs.js", 1],
  ["dynamic-code-execution:node_modules/@noble/curves/abstract/fft.js", 2],
  ["dynamic-code-execution:node_modules/ajv/dist/compile/index.js", 1],
  ["dynamic-code-execution:node_modules/ajv/dist/compile/jtd/parse.js", 1],
  ["dynamic-code-execution:node_modules/ajv/dist/compile/jtd/serialize.js", 1],
  ["dynamic-code-execution:node_modules/depd/index.js", 1],
  ["dynamic-code-execution:node_modules/jszip/dist/jszip.js", 1],
  ["dynamic-code-execution:node_modules/jszip/dist/jszip.min.js", 1],
  ["dynamic-code-execution:node_modules/playwright-core/lib/coreBundle.js", 27],
  ["dynamic-code-execution:node_modules/playwright-core/lib/utilsBundle.js", 2],
  [
    "dynamic-code-execution:node_modules/playwright-core/lib/vite/traceViewer/assets/defaultSettingsView-<hash>.js",
    5,
  ],
  ["dynamic-code-execution:node_modules/real-require/src/index.js", 1],
  ["dynamic-code-execution:node_modules/setimmediate/setImmediate.js", 1],
  ["env-harvesting:node_modules/@tybys/wasm-util/dist/wasm-util.esm.min.js", 1],
  ["env-harvesting:node_modules/@tybys/wasm-util/dist/wasm-util.min.js", 1],
]);

type CriticalFinding = Pick<SkillScanFinding, "line" | "ruleId"> & { path: string };

function normalizeFindingPath(file: string): string {
  const name = path.posix.basename(file);
  for (const prefix of [
    "client",
    "defaultSettingsView",
    "dist",
    "dynamic-tools",
    "monitor",
    "receive-recovery",
    "runtime-entry",
    "service",
    "session-catalog",
    "transport-stdio",
    "worker-client",
  ]) {
    const match = new RegExp(`^${prefix}-[A-Za-z0-9_-]{8}\\.(m?js)$`, "u").exec(name);
    if (match?.[1]) {
      return `${path.posix.dirname(file)}/${prefix}-<hash>.${match[1]}`;
    }
  }
  return file;
}

function normalizeExecutablePath(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\\")) {
    throw new Error("Plugin npm executable path is invalid.");
  }
  const withoutPrefix = value.replace(/^(?:\.\/)+/u, "");
  const normalized = path.posix.normalize(withoutPrefix);
  if (
    normalized !== withoutPrefix ||
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    path.posix.isAbsolute(normalized)
  ) {
    throw new Error("Plugin npm executable path is invalid.");
  }
  return normalized;
}

function declaredExecutablePaths(
  manifest: Record<string, unknown>,
  packedFiles: readonly string[],
): Set<string> {
  const packed = new Set(packedFiles);
  const declared = new Set<string>();
  const add = (value: unknown) => {
    const target = normalizeExecutablePath(value);
    if (!packed.has(target)) {
      throw new Error(`Plugin npm executable is absent from the tarball: ${target}`);
    }
    declared.add(target);
  };
  if (typeof manifest.bin === "string") {
    add(manifest.bin);
  } else if (manifest.bin && typeof manifest.bin === "object" && !Array.isArray(manifest.bin)) {
    for (const value of Object.values(manifest.bin)) {
      add(value);
    }
  } else if (manifest.bin !== undefined) {
    throw new Error("Plugin npm bin declaration is invalid.");
  }
  if (manifest.directories && typeof manifest.directories === "object") {
    const binDirectory = (manifest.directories as Record<string, unknown>).bin;
    if (binDirectory !== undefined) {
      const directory = normalizeExecutablePath(binDirectory);
      const prefix = `${directory}/`;
      const matches = packedFiles.filter((file) => file.startsWith(prefix));
      if (matches.length === 0) {
        throw new Error(`Plugin npm executable directory is absent from the tarball: ${directory}`);
      }
      for (const file of matches) {
        declared.add(file);
      }
    }
  }
  return declared;
}

function isVendoredDependencyTestPath(packagePath: string): boolean {
  if (!packagePath.startsWith("node_modules/")) {
    return false;
  }
  if (
    /(?:^|\/)node_modules\/(?:@[^/]+\/)?[^/]+\/(?:benchmarks?|docs?|examples?|test|tests|__fixtures__|__tests__)\//u.test(
      packagePath,
    )
  ) {
    return true;
  }
  if (/\.(?:[cm]?ts|tsx)$/u.test(packagePath)) {
    return true;
  }
  return /(?:^|[.-])(?:fixture|fixtures|mock|mocks|spec|test|test-helper|test-helpers|test-harness|test-support)(?:[.-]|$)/u.test(
    path.posix.basename(packagePath),
  );
}

function dependencyFindingPath(file: string): string | undefined {
  const marker = "node_modules/";
  const index = file.lastIndexOf(marker);
  return index === -1 ? undefined : file.slice(index);
}

export function scanPluginNpmArtifactSecurity(params: {
  packageName: string;
  packageVersion: string;
  tarball: Buffer;
}) {
  const initial = inspectPackageTarballBytes(params.tarball, {
    maxArchiveBytes: MAX_ARCHIVE_BYTES,
  });
  if (
    initial.packageManifest.name !== params.packageName ||
    initial.packageManifest.version !== params.packageVersion
  ) {
    throw new Error("Plugin npm security scan package identity mismatch.");
  }
  const packedFiles = initial.inventory
    .filter((entry) => entry.type === "file")
    .map((entry) => entry.path.replace(/^package\//u, ""));
  const fixturePaths = packedFiles.filter(isPluginTestFixturePath).toSorted();
  if (fixturePaths.length > 0) {
    throw new Error(
      `Plugin npm artifact contains test or fixture files: ${fixturePaths.join(", ")}`,
    );
  }
  const executables = declaredExecutablePaths(initial.packageManifest, packedFiles);
  const critical: CriticalFinding[] = [];
  let scannedFiles = 0;
  let scannedBytes = 0;
  inspectPackageTarballBytes(params.tarball, {
    maxArchiveBytes: MAX_ARCHIVE_BYTES,
    onFile: ({ content, path: archivePath }: { content: Uint8Array; path: string }) => {
      const packedPath = archivePath.replace(/^package\//u, "");
      if (isVendoredDependencyTestPath(packedPath)) {
        return;
      }
      if (
        !isScannable(packedPath) &&
        !executables.has(packedPath) &&
        path.posix.extname(packedPath) !== ""
      ) {
        return;
      }
      if (content.byteLength > MAX_FILE_BYTES) {
        throw new Error(`${packedPath}: plugin security scan file exceeds the byte limit.`);
      }
      scannedFiles += 1;
      scannedBytes += content.byteLength;
      if (scannedFiles > MAX_FILES || scannedBytes > MAX_TOTAL_BYTES) {
        throw new Error("Plugin npm security scan exceeds its artifact limits.");
      }
      for (const finding of scanSource(Buffer.from(content).toString("utf8"), packedPath)) {
        if (finding.severity === "critical") {
          critical.push({
            line: finding.line,
            path: normalizeFindingPath(packedPath),
            ruleId: finding.ruleId,
          });
        }
      }
    },
  });
  const observed = new Map<string, number>();
  const unexpected: CriticalFinding[] = [];
  for (const finding of critical) {
    const dependencyPath = dependencyFindingPath(finding.path);
    const layout = finding.path.startsWith("dist/.setup/")
      ? "setup"
      : finding.path.startsWith("dist/")
        ? "dist"
        : "source";
    const key = dependencyPath
      ? `${finding.ruleId}:${dependencyPath}`
      : `${layout}:${params.packageName}:${finding.ruleId}:${finding.path}`;
    const count = (observed.get(key) ?? 0) + 1;
    observed.set(key, count);
    const reviewedLimit = dependencyPath
      ? REVIEWED_DEPENDENCY_FINDING_LIMITS.get(key)
      : REVIEWED_CRITICAL_FINDING_LIMITS.get(key);
    if (count > (reviewedLimit ?? 0)) {
      unexpected.push(finding);
    }
  }
  if (unexpected.length > 0) {
    throw new Error(
      `${params.packageName}: unreviewed critical findings in exact npm artifact: ${JSON.stringify(unexpected)}`,
    );
  }
  return {
    packageName: params.packageName,
    packageVersion: params.packageVersion,
    scannedFiles,
    criticalFindingCount: critical.length,
    tarballSha256: initial.tarballSha256,
  };
}

function parseArgs(argv: string[]) {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith("--") || value === undefined || values.has(name)) {
      throw new Error(`Invalid plugin npm security scan argument near ${String(name)}.`);
    }
    values.set(name, value);
  }
  const packageName = values.get("--package-name") ?? "";
  const packageVersion = values.get("--package-version") ?? "";
  const tarball = values.get("--tarball") ?? "";
  if (!packageName || !packageVersion || !tarball || values.size !== 3) {
    throw new Error("Plugin npm security scan requires package name, version, and tarball.");
  }
  return { packageName, packageVersion, tarball };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const report = scanPluginNpmArtifactSecurity({
      packageName: args.packageName,
      packageVersion: args.packageVersion,
      tarball: readFileSync(args.tarball),
    });
    console.log(JSON.stringify(report));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
