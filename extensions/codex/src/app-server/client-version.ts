import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { parse as parseSemver } from "semver";
import type { CodexInitializeResponse } from "./protocol.js";
import { CODEX_APP_SERVER_VERSION, MIN_SUPPORTED_CODEX_APP_SERVER_VERSION } from "./version.js";

export type CodexAppServerRuntimeIdentity = {
  serverVersion: string;
  userAgent?: string;
  codexHome?: string;
  platformFamily?: string;
  platformOs?: string;
};

class CodexAppServerVersionError extends Error {
  readonly detectedVersion?: string;

  constructor(detectedVersion: string | undefined) {
    const detected = detectedVersion
      ? `detected ${detectedVersion}`
      : "OpenClaw could not determine the running Codex version";
    super(
      `Codex app-server ${MIN_SUPPORTED_CODEX_APP_SERVER_VERSION} or newer is required, but ${detected}. Update the configured Codex app-server binary, or remove custom command overrides to use the managed binary.`,
    );
    this.name = "CodexAppServerVersionError";
    this.detectedVersion = detectedVersion;
  }
}

export function assertSupportedCodexAppServerVersion(response: CodexInitializeResponse): string {
  const detectedVersion = readCodexVersionFromUserAgent(response.userAgent);
  if (!detectedVersion) {
    throw new CodexAppServerVersionError(detectedVersion);
  }
  const detected = parseSemver(detectedVersion);
  if (!detected || detected.compare(MIN_SUPPORTED_CODEX_APP_SERVER_VERSION) < 0) {
    throw new CodexAppServerVersionError(detectedVersion);
  }
  if (detected.compare(CODEX_APP_SERVER_VERSION) > 0) {
    embeddedAgentLog.warn(
      "codex app-server is newer than OpenClaw's managed runtime; continuing with normal startup validation",
      {
        detectedVersion,
        validatedVersion: CODEX_APP_SERVER_VERSION,
      },
    );
  }
  return detectedVersion;
}

export function isUnsupportedCodexAppServerVersionError(error: unknown): boolean {
  return error instanceof CodexAppServerVersionError;
}

export function buildCodexAppServerRuntimeIdentity(
  response: CodexInitializeResponse,
  serverVersion: string,
): CodexAppServerRuntimeIdentity {
  const userAgent = normalizeOptionalString(response.userAgent);
  const codexHome = normalizeOptionalString(response.codexHome);
  const platformFamily = normalizeOptionalString(response.platformFamily);
  const platformOs = normalizeOptionalString(response.platformOs);
  return {
    serverVersion,
    ...(userAgent ? { userAgent } : {}),
    ...(codexHome ? { codexHome } : {}),
    ...(platformFamily ? { platformFamily } : {}),
    ...(platformOs ? { platformOs } : {}),
  };
}

function readCodexVersionFromUserAgent(userAgent: string | undefined): string | undefined {
  // Codex returns `<originator>/<codex-version> ...`; the originator can be
  // OpenClaw, Codex Desktop, or an env override, so only the slash-delimited
  // version in the leading product field is stable.
  const match = userAgent?.match(
    /^[^/]+\/(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)(?:[\s(]|$)/,
  );
  return match?.[1];
}
