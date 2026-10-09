import { embeddedAgentLog, OPENCLAW_VERSION } from "openclaw/plugin-sdk/agent-harness-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { parse as parseSemver } from "semver";
import { CODEX_APP_SERVER_OPT_OUT_NOTIFICATION_METHODS } from "./notification-policy.js";
import type { CodexInitializeParams, CodexInitializeResponse } from "./protocol.js";
import type { CodexRequestAttemptObservation } from "./request-attempt.js";
import type { CodexRequestWaiterOutcome, CodexRequestWireOutcome } from "./request-observation.js";
import { CODEX_APP_SERVER_VERSION, MIN_SUPPORTED_CODEX_APP_SERVER_VERSION } from "./version.js";

type InitializeDiagnostic = {
  boundary: "request" | "version-validation" | "initialized-notification" | "ready";
  outcome: "pending" | "succeeded" | "failed";
  overloadAttemptOrdinal: number;
  writeState: "not-attempted" | "possible-write" | "callback-ok" | "callback-error";
  wireOutcome: CodexRequestWireOutcome;
  waiterOutcome?: CodexRequestWaiterOutcome;
};

/** Scalar observations only: a stream callback is not a native response. */
export function createCodexInitializeDiagnostics() {
  let current: InitializeDiagnostic | undefined;
  let beforeClose: (InitializeDiagnostic & { clientClosed: boolean }) | undefined;
  return {
    begin() {
      let snapshot: InitializeDiagnostic = {
        boundary: "request",
        outcome: "pending",
        overloadAttemptOrdinal: 0,
        writeState: "not-attempted",
        wireOutcome: "not-written",
      };
      current = snapshot;
      return {
        boundary(boundary: InitializeDiagnostic["boundary"]) {
          if (current === snapshot) {
            snapshot.boundary = boundary;
          }
        },
        finish(succeeded: boolean) {
          if (current === snapshot) {
            snapshot.outcome = succeeded ? "succeeded" : "failed";
          }
        },
        attempt(ordinal: number) {
          if (current !== snapshot) {
            return undefined;
          }
          const attempt: InitializeDiagnostic = {
            boundary: "request",
            outcome: "pending",
            overloadAttemptOrdinal: ordinal,
            writeState: "not-attempted",
            wireOutcome: "retained-pending",
          };
          current = snapshot = attempt;
          return {
            observe(this: void, event: CodexRequestAttemptObservation) {
              if (event.kind === "wire") {
                attempt.wireOutcome = event.outcome;
              } else if (event.kind === "waiter") {
                attempt.waiterOutcome = event.outcome;
              } else {
                attempt.writeState = "possible-write";
              }
            },
            writeResult(this: void, error?: Error | null) {
              attempt.writeState = error ? "callback-error" : "callback-ok";
            },
          };
        },
      };
    },
    closing() {
      if (current && !beforeClose) {
        beforeClose = { ...current, clientClosed: false };
      }
    },
    snapshot(clientClosed: boolean, beforeClientClose = false) {
      if (beforeClientClose) {
        return beforeClose ? { ...beforeClose } : undefined;
      }
      return current ? { ...current, clientClosed } : undefined;
    },
  };
}

export function buildCodexAppServerInitializeParams(): CodexInitializeParams {
  return {
    clientInfo: {
      name: "openclaw",
      title: "OpenClaw",
      version: OPENCLAW_VERSION,
    },
    capabilities: {
      experimentalApi: true,
      optOutNotificationMethods: [...CODEX_APP_SERVER_OPT_OUT_NOTIFICATION_METHODS],
      extensions: {
        "openai/standard-form-input": {},
        "openai/form": {},
        "openai/elicitation": { form: {} },
        "io.modelcontextprotocol/ui": {
          mimeTypes: ["text/html;profile=mcp-app"],
        },
      },
    },
  };
}

export function buildCodexAppServerRuntimeIdentity(
  response: CodexInitializeResponse,
  serverVersion: string,
) {
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

class CodexAppServerVersionError extends Error {
  constructor(readonly detectedVersion?: string) {
    const detected = detectedVersion
      ? `detected ${detectedVersion}`
      : "OpenClaw could not determine the running Codex version";
    super(
      `Codex app-server ${MIN_SUPPORTED_CODEX_APP_SERVER_VERSION} or newer is required, but ${detected}. Update the configured Codex app-server binary, or remove custom command overrides to use the managed binary.`,
    );
    this.name = "CodexAppServerVersionError";
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

function readCodexVersionFromUserAgent(userAgent: string | undefined): string | undefined {
  // Codex returns `<originator>/<codex-version> ...`; the originator can be
  // OpenClaw, Codex Desktop, or an env override, so only the slash-delimited
  // version in the leading product field is stable.
  const match = userAgent?.match(
    /^[^/]+\/(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)(?:[\s(]|$)/,
  );
  return match?.[1];
}

export function isUnsupportedCodexAppServerVersionError(error: unknown): boolean {
  return error instanceof CodexAppServerVersionError;
}
