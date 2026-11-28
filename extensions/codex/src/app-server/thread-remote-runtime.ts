import { OPENCLAW_VERSION } from "openclaw/plugin-sdk/agent-harness-registration";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { safeParseJson } from "openclaw/plugin-sdk/text-utility-runtime";
import { parse as parseSemver } from "semver";
import { buildCodexAppServerRuntimeFingerprint } from "./plugin-app-cache-key.js";
import type { CodexAppServerThreadBinding } from "./session-binding.js";
import type { CodexStartOrResumeThreadParams } from "./thread-lifecycle-types.js";

export function matchCodexRemoteResumeRuntimeFingerprint(
  params: CodexStartOrResumeThreadParams,
  binding: CodexAppServerThreadBinding,
): string | undefined {
  const { appServer, appServerRuntimeFingerprint: current, client } = params;
  const saved = binding.appServerRuntimeFingerprint;
  const { start } = appServer;
  // Config admission already requires authentication for a remote connection.
  if (
    !saved ||
    !current ||
    current === saved ||
    binding.connectionScope !== undefined ||
    binding.nativeToolPolicyRestricted ||
    binding.restrictedThreadConfigFingerprint ||
    binding.ringZeroConfigFingerprint !== undefined ||
    params.nativeCodeModeEnabled === false ||
    appServer.connectionClass !== "remote" ||
    start.transport !== "websocket" ||
    !start.url ||
    URL.parse(start.url)?.protocol !== "wss:"
  ) {
    return undefined;
  }

  const runtimeIdentity = client.getRuntimeIdentity();
  if (
    !runtimeIdentity?.serverVersion ||
    !runtimeIdentity.userAgent ||
    !runtimeIdentity.codexHome ||
    !runtimeIdentity.platformFamily ||
    !runtimeIdentity.platformOs ||
    current !== buildCodexAppServerRuntimeFingerprint({ appServer, runtimeIdentity })
  ) {
    return undefined;
  }

  // Codex appends the initializing client's name and version to its user agent.
  const echoStart = " (openclaw; ";
  const liveEcho = `${echoStart}${OPENCLAW_VERSION})`;
  const userAgentPrefix = runtimeIdentity.userAgent.slice(0, -liveEcho.length);
  if (
    !runtimeIdentity.userAgent.endsWith(liveEcho) ||
    !parseSemver(OPENCLAW_VERSION) ||
    !userAgentPrefix ||
    userAgentPrefix.includes(echoStart)
  ) {
    return undefined;
  }

  const savedFingerprint = asOptionalRecord(safeParseJson<unknown>(saved));
  const savedUserAgent = asOptionalRecord(savedFingerprint?.runtimeIdentity)?.userAgent;
  const savedVersion =
    typeof savedUserAgent === "string"
      ? savedUserAgent.match(/ \(openclaw; ([0-9][0-9A-Za-z.+-]*)\)$/u)?.[1]
      : undefined;
  if (!savedVersion || !parseSemver(savedVersion)) {
    return undefined;
  }

  // Reconstruct the whole fingerprint with only the saved version substituted.
  const expectedSaved = buildCodexAppServerRuntimeFingerprint({
    appServer,
    runtimeIdentity: {
      ...runtimeIdentity,
      userAgent: `${userAgentPrefix}${echoStart}${savedVersion})`,
    },
  });
  return expectedSaved === saved ? saved : undefined;
}
