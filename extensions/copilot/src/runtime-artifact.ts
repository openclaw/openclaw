import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import type { StdioRuntimeConnection } from "@github/copilot-sdk";
import type { AgentHarnessRuntimeArtifactBinding } from "openclaw/plugin-sdk/agent-harness-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { fingerprintCopilotPackage, loadCopilotSdkWithIdentity } from "./sdk-loader.js";

function runtimePlatform(): string {
  if (process.arch !== "x64" && process.arch !== "arm64") {
    throw new Error(`Copilot runtime artifacts do not support architecture ${process.arch}.`);
  }
  if (process.platform === "linux") {
    const report = process.report?.getReport();
    const header = isRecord(report) && isRecord(report.header) ? report.header : undefined;
    return `${header?.glibcVersionRuntime ? "linux" : "linuxmusl"}-${process.arch}`;
  }
  if (process.platform === "darwin" || process.platform === "win32") {
    return `${process.platform}-${process.arch}`;
  }
  throw new Error(`Copilot runtime artifacts do not support platform ${process.platform}.`);
}

async function resolveRuntimePackage(entryPath: string, packageName: string): Promise<string> {
  // Resolve the SDK's own optional dependency afresh: require.resolve caches
  // symlink targets, which would hide a replaced installation during validation.
  const lookupPaths = createRequire(entryPath).resolve.paths(packageName) ?? [];
  const packageRoot = lookupPaths
    .map((lookupPath) => path.join(lookupPath, packageName))
    .find((candidate) => existsSync(path.join(candidate, "package.json")));
  if (!packageRoot) {
    throw new Error(`Copilot runtime package ${packageName} is not installed.`);
  }
  return await fs.realpath(packageRoot);
}

export async function captureCopilotRuntimeArtifact(env: NodeJS.ProcessEnv = process.env): Promise<{
  binding: AgentHarnessRuntimeArtifactBinding;
  connection: StdioRuntimeConnection;
}> {
  // The SDK chooses its default transport from the host environment even when
  // client-level env overrides are supplied. Never verify a different transport.
  const defaultConnection = process.env.COPILOT_SDK_DEFAULT_CONNECTION;
  if (defaultConnection && defaultConnection.toLowerCase() !== "stdio") {
    throw new Error("Copilot runtime artifact verification requires the stdio transport.");
  }
  const { sdk, identity } = await loadCopilotSdkWithIdentity();
  if ((await fingerprintCopilotPackage(identity.packageRoot)) !== identity.fingerprint) {
    throw new Error(
      "Copilot SDK changed after loading. Restart OpenClaw before verifying inference.",
    );
  }
  const platform = runtimePlatform();
  const packageName = `@github/copilot-sdk-${platform}`;
  const packageRoot = await resolveRuntimePackage(identity.entryPath, packageName);
  // The SDK publishes its native runtime as an optional platform package. Pin
  // that packaged executable through the SDK's public RuntimeConnection API.
  const executable = await fs.realpath(
    path.join(
      packageRoot,
      "prebuilds",
      platform,
      process.platform === "win32" ? "copilot-runtime.exe" : "copilot-runtime",
    ),
  );
  if (env.COPILOT_CLI_PATH && (await fs.realpath(env.COPILOT_CLI_PATH)) !== executable) {
    throw new Error(
      "Copilot runtime artifact verification does not support a custom COPILOT_CLI_PATH.",
    );
  }
  const runtimeFingerprint = await fingerprintCopilotPackage(packageRoot);
  // Setup revalidation uses a fresh plugin generation with different capture
  // paths. Identify the implementation bytes, not a temporary snapshot location.
  const entry = path.relative(identity.packageRoot, identity.entryPath).split(path.sep).join("/");
  const id = `copilot-sdk:${platform}:${entry}`;
  const fingerprint = createHash("sha256")
    .update(JSON.stringify([id, identity.fingerprint, runtimeFingerprint]))
    .digest("hex");
  return {
    binding: { id, fingerprint },
    connection: sdk.RuntimeConnection.forStdio({ path: executable }),
  };
}

export async function validateCopilotRuntimeArtifact(
  binding: AgentHarnessRuntimeArtifactBinding,
): Promise<boolean> {
  try {
    const current = await captureCopilotRuntimeArtifact();
    return current.binding.id === binding.id && current.binding.fingerprint === binding.fingerprint;
  } catch {
    return false;
  }
}
