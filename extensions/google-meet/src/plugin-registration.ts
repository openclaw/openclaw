import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { GatewayRequestHandlerOptions } from "openclaw/plugin-sdk/gateway-runtime";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import type {
  OpenClawPluginApi,
  OpenClawPluginNodeInvokePolicy,
} from "openclaw/plugin-sdk/plugin-entry";
import {
  asNonArrayRecord as asParamRecord,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { GoogleMeetBrowserManualActionError } from "./browser-manual-action-error.js";
import {
  resolveGoogleMeetGatewayOperationTimeoutMs,
  type GoogleMeetConfig,
  type GoogleMeetMode,
  type GoogleMeetTransport,
} from "./config.js";
import type { GoogleMeetRuntime } from "./runtime.js";
import { GOOGLE_MEET_NODE_COMMAND } from "./transports/google-meet-platform-constants.js";

export const loadGoogleMeetPluginHelpers = createLazyRuntimeModule(
  () => import("./plugin-helpers.js"),
);
export const loadGoogleMeetCliModule = createLazyRuntimeModule(() => import("./cli.js"));
export const loadGoogleMeetCreateModule = createLazyRuntimeModule(() => import("./create.js"));
export const loadGoogleMeetNodeHostModule = createLazyRuntimeModule(() => import("./node-host.js"));

const loadGoogleMeetRuntimeModule = createLazyRuntimeModule(() => import("./runtime.js"));
const loadGoogleMeetNodeInvokePolicyModule = createLazyRuntimeModule(
  () => import("./node-invoke-policy.js"),
);
const loadGoogleMeetGatewayRuntimeModule = createLazyRuntimeModule(
  () => import("openclaw/plugin-sdk/gateway-runtime"),
);

type CallGatewayFromCli = typeof import("openclaw/plugin-sdk/gateway-runtime").callGatewayFromCli;
type GoogleMeetGatewayErrorCode = NonNullable<
  Parameters<GatewayRequestHandlerOptions["respond"]>[2]
>["code"];

type LoadGoogleMeetNodeInvokePolicy = (
  config: GoogleMeetConfig,
) => Promise<OpenClawPluginNodeInvokePolicy>;

const loadGoogleMeetNodeInvokePolicy: LoadGoogleMeetNodeInvokePolicy = async (config) =>
  (await loadGoogleMeetNodeInvokePolicyModule()).createGoogleMeetChromeNodeInvokePolicy(config);

export function normalizeTransport(value: unknown): GoogleMeetTransport | undefined {
  return value === "chrome" || value === "chrome-node" || value === "twilio" ? value : undefined;
}

export function normalizeMode(value: unknown): GoogleMeetMode | undefined {
  if (value === "realtime") {
    return "agent";
  }
  return value === "agent" || value === "bidi" || value === "transcribe" ? value : undefined;
}

export function resolveMeetingInput(config: GoogleMeetConfig, value: unknown): string {
  const meeting = normalizeOptionalString(value) ?? config.defaults.meeting;
  if (!meeting) {
    throw new Error("Meeting input is required");
  }
  return meeting;
}

export function shouldJoinCreatedMeet(raw: Record<string, unknown>): boolean {
  return raw.join !== false && raw.join !== "false";
}

const googleMeetToolDeps: {
  callGatewayFromCli?: CallGatewayFromCli;
  platform: () => NodeJS.Platform;
} = {
  platform: () => process.platform,
};

const googleMeetGatewayMethods = {
  join: "googlemeet.join",
  create: "googlemeet.create",
  status: "googlemeet.status",
  transcript: "googlemeet.transcript",
  participate: "googlemeet.participate",
  leave: "googlemeet.leave",
  speak: "googlemeet.speak",
  participation_context: "googlemeet.participationContext",
  recover_current_tab: "googlemeet.recoverCurrentTab",
  setup_status: "googlemeet.setup",
  test_speech: "googlemeet.testSpeech",
  test_listen: "googlemeet.testListen",
  end_active_conference: "googlemeet.endActiveConference",
};

export function readGoogleMeetParticipationParams(raw: Record<string, unknown>): {
  sessionId: string;
  request: Parameters<GoogleMeetRuntime["participate"]>[1];
} {
  const sessionId = normalizeOptionalString(raw.sessionId);
  if (!sessionId) {
    throw new Error("sessionId required");
  }
  const requestId = normalizeOptionalString(raw.requestId);
  if (!requestId) {
    throw new Error("requestId required");
  }
  for (const name of ["sourceId", "correctionOf"] as const) {
    if (raw[name] !== undefined && !normalizeOptionalString(raw[name])) {
      throw new Error(`${name} must be a non-empty string`);
    }
  }
  const action = asParamRecord(raw.participationAction);
  const type = normalizeOptionalString(action.type);
  if (!type) {
    throw new Error("participationAction.type required");
  }
  for (const name of ["text", "reaction"] as const) {
    if (action[name] !== undefined && typeof action[name] !== "string") {
      throw new Error(`participationAction.${name} must be a string`);
    }
  }
  return {
    sessionId,
    request: {
      requestId,
      ...(raw.sourceId !== undefined ? { sourceId: normalizeOptionalString(raw.sourceId) } : {}),
      ...(raw.correctionOf !== undefined
        ? { correctionOf: normalizeOptionalString(raw.correctionOf) }
        : {}),
      action: { ...action, type },
    },
  };
}

export function assertGoogleMeetAgentToolActionSupported(params: {
  config: GoogleMeetConfig;
  raw: Record<string, unknown>;
}): void {
  const platform = googleMeetToolDeps.platform();
  if (platform === "darwin" || platform === "linux") {
    return;
  }
  const action = params.raw.action;
  if (
    action !== "join" &&
    action !== "test_speech" &&
    !(action === "create" && shouldJoinCreatedMeet(params.raw))
  ) {
    return;
  }
  const transport = normalizeTransport(params.raw.transport) ?? params.config.defaultTransport;
  const mode =
    action === "test_speech"
      ? "agent"
      : (normalizeMode(params.raw.mode) ?? params.config.defaultMode);
  if (transport !== "chrome" || (mode !== "agent" && mode !== "bidi")) {
    return;
  }
  throw new Error(
    "Google Meet local Chrome talk-back audio requires macOS with BlackHole 2ch or Linux with PipeWire-Pulse. On this host, use mode: transcribe, transport: twilio, or a supported chrome-node.",
  );
}

export async function callGoogleMeetGatewayFromTool(params: {
  config: GoogleMeetConfig;
  action: keyof typeof googleMeetGatewayMethods;
  raw: Record<string, unknown>;
  runtime?: OpenClawPluginApi["runtime"];
}): Promise<unknown> {
  const method = googleMeetGatewayMethods[params.action];
  try {
    if (params.runtime) {
      return await params.runtime.gateway.request(method, params.raw, {
        timeoutMs: resolveGoogleMeetGatewayOperationTimeoutMs(params.config),
        scopes: ["operator.admin"],
      });
    }
    // Standalone agent workers connect as this bundled plugin, not as the
    // model session; its Gateway methods remain the only exposed actions.
    const callGatewayFromCli =
      googleMeetToolDeps.callGatewayFromCli ??
      (await loadGoogleMeetGatewayRuntimeModule()).callGatewayFromCli;
    return await callGatewayFromCli(
      method,
      {
        json: true,
        timeout: String(resolveGoogleMeetGatewayOperationTimeoutMs(params.config)),
      },
      params.raw,
      { progress: false, scopes: ["operator.admin"] },
    );
  } catch (err) {
    const details = err && typeof err === "object" && "details" in err ? err.details : undefined;
    if (details && typeof details === "object") {
      return details;
    }
    throw err;
  }
}

export function keepTrustedToolAgentId(
  raw: Record<string, unknown>,
  client: GatewayRequestHandlerOptions["client"],
): Record<string, unknown> {
  const { agentId: rawAgentId, ...rest } = raw;
  if (client?.internal?.pluginRuntimeOwnerId !== "google-meet") {
    return rest;
  }
  const agentId = normalizeOptionalString(rawAgentId);
  return agentId ? { ...rest, agentId } : rest;
}

export function createGoogleMeetRuntimeAccessor(params: {
  api: OpenClawPluginApi;
  config: GoogleMeetConfig;
}): () => Promise<GoogleMeetRuntime> {
  let transcriptsEnabled = params.api.config.transcripts?.enabled !== false;
  let runtime: GoogleMeetRuntime | undefined;
  let runtimePromise: Promise<GoogleMeetRuntime> | undefined;
  params.api.registerService({
    id: "google-meet-transcripts",
    reload: { configPrefixes: ["transcripts.enabled"] },
    start: ({ config }) => {
      transcriptsEnabled = config.transcripts?.enabled !== false;
      return runtime?.reconcileTranscriptPolicy(transcriptsEnabled);
    },
    stop: () => {
      transcriptsEnabled = false;
      return runtime?.reconcileTranscriptPolicy(false);
    },
  });
  return async () => {
    if (!params.config.enabled) {
      throw new Error("Google Meet plugin disabled in plugin config");
    }
    runtimePromise ??= loadGoogleMeetRuntimeModule().then(
      async ({ GoogleMeetRuntime: Runtime }) => {
        runtime = new Runtime({
          config: params.config,
          fullConfig: params.api.config,
          runtime: params.api.runtime,
          logger: params.api.logger,
        });
        await runtime.reconcileTranscriptPolicy(transcriptsEnabled);
        return runtime;
      },
    );
    return await runtimePromise;
  };
}

export function createLazyGoogleMeetNodeInvokePolicy(
  config: GoogleMeetConfig,
  loadPolicy: LoadGoogleMeetNodeInvokePolicy = loadGoogleMeetNodeInvokePolicy,
): OpenClawPluginNodeInvokePolicy {
  let policyPromise: Promise<OpenClawPluginNodeInvokePolicy> | undefined;
  return {
    commands: [GOOGLE_MEET_NODE_COMMAND],
    dangerous: true,
    async handle(ctx) {
      let policy: OpenClawPluginNodeInvokePolicy;
      try {
        policyPromise ??= loadPolicy(config);
        policy = await policyPromise;
      } catch (error) {
        return {
          ok: false,
          code: "PLUGIN_POLICY_UNAVAILABLE",
          message: `google-meet PLUGIN_POLICY_UNAVAILABLE: node.invoke policy unavailable: ${formatErrorMessage(error)}`,
          unavailable: true,
        };
      }
      return await policy.handle(ctx);
    },
  };
}

export function formatGoogleMeetGatewayError(err: unknown) {
  return err instanceof GoogleMeetBrowserManualActionError
    ? err.payload
    : { error: formatErrorMessage(err) };
}

export function sendGoogleMeetGatewayError(
  respond: GatewayRequestHandlerOptions["respond"],
  err: unknown,
  code: GoogleMeetGatewayErrorCode = "UNAVAILABLE",
): void {
  const payload = formatGoogleMeetGatewayError(err);
  respond(false, payload, {
    code,
    message: typeof payload.error === "string" ? payload.error : "Google Meet request failed",
    details: payload,
  });
}

export const testing = {
  setCallGatewayFromCliForTests(next?: CallGatewayFromCli): void {
    googleMeetToolDeps.callGatewayFromCli = next;
  },
  setPlatformForTests(next?: () => NodeJS.Platform): void {
    googleMeetToolDeps.platform = next ?? (() => process.platform);
  },
};
