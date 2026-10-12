import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { hostname } from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { assertNoSymlinkParents, readRegularFile } from "openclaw/plugin-sdk/file-access-runtime";
import { z } from "zod";
import type { NativeBrowserPolicyReport } from "./native-policy.js";
import { getBrowserProfileCapabilities } from "./profile-capabilities.js";
import type { ResolvedBrowserProfile } from "./profile.types.js";

export const NATIVE_POLICY_MAX_BYTES = 64 * 1024;
export const NATIVE_POLICY_ARTIFACT_MARKER = "// OpenClaw local native browser policy v1\n";
export const nativePolicyInputSchema = z
  .record(z.string().min(1), z.json())
  .refine(
    (value) => Object.keys(value).length > 0,
    "Native policy JSON must contain at least one policy.",
  )
  .refine(
    (value) => Buffer.byteLength(JSON.stringify(value, null, 2), "utf8") <= NATIVE_POLICY_MAX_BYTES,
    "Native policy JSON must not exceed 64 KiB.",
  );
export const nativePolicySetupRequestSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("install"), policies: nativePolicyInputSchema }),
  z.object({ operation: z.literal("remove") }),
  z.object({ operation: z.literal("inspect") }),
]);

export type NativePolicySetupPlan =
  | { state: "unsupported" | "blocked"; detail: string }
  | {
      state: "ready";
      browser: string;
      browserHost: string;
      executablePath: string;
      targetPath: string;
      scope: "machine";
      operation: "install" | "update" | "remove" | "inspect";
      previousHash: string | null;
      content: string | null;
      contentHash: string | null;
      currentPolicies: Extract<NativeBrowserPolicyReport, { policies: unknown }>["policies"];
    };

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

/** Read only our named artifact, on the host that owns the browser filesystem. */
export async function planNativeBrowserPolicySetup(params: {
  report: NativeBrowserPolicyReport;
  profile: ResolvedBrowserProfile;
  request: z.infer<typeof nativePolicySetupRequestSchema>;
}): Promise<NativePolicySetupPlan> {
  const { report, profile, request } = params;
  const capabilities = getBrowserProfileCapabilities(profile);
  // These deployments have a verified host /etc policy namespace. A product
  // label alone cannot establish Snap, Flatpak or custom build policy paths.
  const verifiedDeployment =
    "policies" in report &&
    (report.browser === "Google Chrome"
      ? ["/opt/google/chrome/chrome", "/opt/google/chrome/google-chrome"].includes(
          report.executablePath,
        )
      : report.browser === "Chromium" &&
        report.executablePath === "/usr/local/share/chromium/chrome-linux/chrome");
  if (
    !("policies" in report) ||
    !verifiedDeployment ||
    report.os !== "Linux" ||
    process.platform !== "linux" ||
    capabilities.mode !== "local-managed" ||
    !capabilities.browserFilesystemLocal
  ) {
    return {
      state: "unsupported",
      detail:
        "Guided local policy setup requires a verified Linux Google Chrome /opt/google/chrome deployment or the tested Chromium /usr/local/share/chromium/chrome-linux/chrome deployment managed on this browser host. For Snap, Flatpak, custom paths, remote CDP, attached browsers or other platforms, use the browser administrator's native policy instructions; automatic setup cannot establish their host policy directory.",
    };
  }
  const directory =
    report.browser === "Google Chrome"
      ? "/etc/opt/chrome/policies/managed"
      : "/etc/chromium/policies/managed";
  const targetPath = path.posix.join(directory, "openclaw.json");
  let previous: string | null = null;
  try {
    await assertNoSymlinkParents({ rootDir: "/", targetPath });
    const stat = await fs.lstat(targetPath).catch((error: unknown) => {
      if (z.object({ code: z.literal("ENOENT") }).safeParse(error).success) {
        return null;
      }
      throw error;
    });
    if (stat) {
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
        return {
          state: "blocked",
          detail: `${targetPath} is not a regular policy artifact with one link.`,
        };
      }
      const { buffer, stat: openedStat } = await readRegularFile({
        filePath: targetPath,
        maxBytes: NATIVE_POLICY_MAX_BYTES + 1024,
      });
      if (openedStat.nlink !== 1) {
        return {
          state: "blocked",
          detail: `${targetPath} has multiple links; contact the browser host administrator.`,
        };
      }
      previous = buffer.toString("utf8");
      if (!previous.startsWith(NATIVE_POLICY_ARTIFACT_MARKER)) {
        return {
          state: "blocked",
          detail: `${targetPath} belongs to another operator. OpenClaw will not replace or remove it. Keep existing OS and MDM policy files under their current owner.`,
        };
      }
      nativePolicyInputSchema.parse(
        JSON.parse(previous.slice(NATIVE_POLICY_ARTIFACT_MARKER.length)),
      );
    }
  } catch {
    return {
      state: "blocked",
      detail: `Cannot safely inspect ${targetPath}. Resolve permissions, symlinked parents or an invalid artifact with the browser host administrator, then plan again.`,
    };
  }
  if (request.operation === "remove" && previous === null) {
    return { state: "blocked", detail: `No OpenClaw policy artifact exists at ${targetPath}.` };
  }
  const content =
    request.operation === "install"
      ? NATIVE_POLICY_ARTIFACT_MARKER + JSON.stringify(request.policies, null, 2) + "\n"
      : null;
  return {
    state: "ready",
    browser: report.browser,
    browserHost: hostname(),
    executablePath: report.executablePath,
    targetPath,
    scope: "machine",
    operation:
      request.operation !== "install"
        ? request.operation
        : previous === null
          ? "install"
          : "update",
    previousHash: previous === null ? null : sha256(previous),
    content,
    contentHash: content === null ? null : sha256(content),
    currentPolicies: report.policies,
  };
}

export type NativePolicyVerification = {
  state: "verified" | "unverified";
  stage: "effective" | "awaiting-activation" | "failed" | "unverified";
  controlReady: boolean;
  issues: Array<{
    policy: string;
    detail: string;
    stage: "awaiting-activation" | "failed" | "unverified";
  }>;
  warnings: Array<{ policy: string; detail: string }>;
};

type NativePolicyValue = z.infer<typeof nativePolicyInputSchema>[string];

function normalizeNativeDisplayValue(
  expected: NativePolicyValue,
  displayed: NativePolicyValue,
): NativePolicyValue {
  // Chromium PolicyConversionsClient::CopyAndMaybeConvert serializes a
  // dictionary, and immediate dictionary list elements, as JSON strings.
  // Other display handlers and masked sensitive fields remain unverified.
  if (
    expected !== null &&
    typeof expected === "object" &&
    !Array.isArray(expected) &&
    typeof displayed === "string"
  ) {
    try {
      return z.record(z.string(), z.json()).parse(JSON.parse(displayed));
    } catch {
      return displayed;
    }
  }
  if (Array.isArray(expected) && Array.isArray(displayed)) {
    return displayed.map((value, index) => {
      const expectedElement = expected[index];
      return expectedElement !== null &&
        typeof expectedElement === "object" &&
        !Array.isArray(expectedElement)
        ? normalizeNativeDisplayValue(expectedElement, value)
        : value;
    });
  }
  return displayed;
}

/** Compare loaded native facts; Chromium alone interprets and enforces policy. */
export function verifyNativeBrowserPolicy(params: {
  policies: z.infer<typeof nativePolicyInputSchema>;
  report: NativeBrowserPolicyReport;
  controlReady: boolean;
}): NativePolicyVerification {
  const issues: NativePolicyVerification["issues"] = [];
  const warnings: NativePolicyVerification["warnings"] = [];
  if (!("policies" in params.report)) {
    issues.push({
      policy: "browser",
      detail: params.report.detail,
      stage: params.report.state === "failed" ? "failed" : "unverified",
    });
  } else {
    for (const [name, expected] of Object.entries(params.policies)) {
      const current = params.report.policies[name];
      if (!current) {
        issues.push({
          policy: name,
          detail:
            "Not loaded by the browser. Reload chrome://policy or restart the browser on its host, then verify again.",
          stage: "awaiting-activation",
        });
        continue;
      }
      if (current.error || current.ignored || current.future || current.restartRequired) {
        issues.push({
          policy: name,
          detail: [
            current.error,
            current.ignored && "ignored",
            current.future && "not supported by this browser version",
            current.restartRequired && "browser restart required",
          ]
            .filter(Boolean)
            .join("; "),
          stage:
            current.error || current.ignored || current.future ? "failed" : "awaiting-activation",
        });
      }
      if (
        current.level !== "mandatory" ||
        current.scope !== "machine" ||
        current.source !== "platform"
      ) {
        issues.push({
          policy: name,
          detail: `Native provider is ${current.level}/${current.scope}/${current.source}; the requested machine platform policy is not confirmed.`,
          stage: "failed",
        });
      }
      if (!isDeepStrictEqual(normalizeNativeDisplayValue(expected, current.value), expected)) {
        issues.push({
          policy: name,
          detail:
            "Native display value differs from the request or has been transformed or masked. Inspect native conflicts and administrator policy in chrome://policy; this value is unverified.",
          stage: "unverified",
        });
      }
      if (current.warning) {
        warnings.push({ policy: name, detail: current.warning });
      }
    }
  }
  if (!params.controlReady) {
    issues.push({
      policy: "browser",
      detail:
        "Browser control is unavailable. Native policy may disable remote debugging; inspect chrome://policy manually or contact the administrator.",
      stage: "failed",
    });
  }
  const stage = issues.some((issue) => issue.stage === "failed")
    ? "failed"
    : issues.some((issue) => issue.stage === "unverified")
      ? "unverified"
      : issues.length
        ? "awaiting-activation"
        : "effective";
  return {
    state: issues.length ? "unverified" : "verified",
    stage,
    controlReady: params.controlReady,
    issues,
    warnings,
  };
}
