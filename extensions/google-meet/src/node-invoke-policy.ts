import type {
  OpenClawPluginNodeInvokePolicy,
  OpenClawPluginNodeInvokePolicyContext,
  OpenClawPluginNodeInvokePolicyResult,
} from "openclaw/plugin-sdk/plugin-entry";
import type { GoogleMeetConfig } from "./config.js";
import { normalizeMeetUrl } from "./runtime.js";

export const GOOGLE_MEET_CHROME_NODE_COMMAND = "googlemeet.chrome";

const START_MODES = new Set(["agent", "bidi", "realtime", "transcribe"]);

type PolicyDecision =
  | { approved: true; params: Record<string, unknown> }
  | { approved: false; result: OpenClawPluginNodeInvokePolicyResult };

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readPositiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function copyCommand(command: string[] | undefined): string[] | undefined {
  return command && command.length > 0 ? [...command] : undefined;
}

function denied(message: string, code = "GOOGLE_MEET_NODE_POLICY_DENIED") {
  return { ok: false as const, code, message };
}

function approved(params: Record<string, unknown>): PolicyDecision {
  return { approved: true, params };
}

function buildStartParams(
  params: Record<string, unknown>,
  config: GoogleMeetConfig,
): PolicyDecision {
  let url: string;
  try {
    url = normalizeMeetUrl(params.url);
  } catch (error) {
    return {
      approved: false,
      result: denied(
        error instanceof Error ? error.message : "googlemeet.chrome start requires url",
      ),
    };
  }
  const mode = readString(params.mode);
  if (mode && !START_MODES.has(mode)) {
    return {
      approved: false,
      result: denied(`googlemeet.chrome start mode is unsupported: ${mode}`),
    };
  }
  const startParams: Record<string, unknown> = {
    action: "start",
    url,
    launch: params.launch === false ? false : config.chrome.launch,
    browserProfile: config.chrome.browserProfile,
    joinTimeoutMs: config.chrome.joinTimeoutMs,
  };
  if (mode) {
    startParams.mode = mode;
  }
  const audioInputCommand = copyCommand(config.chrome.audioInputCommand);
  if (audioInputCommand) {
    startParams.audioInputCommand = audioInputCommand;
  }
  const audioOutputCommand = copyCommand(config.chrome.audioOutputCommand);
  if (audioOutputCommand) {
    startParams.audioOutputCommand = audioOutputCommand;
  }
  const audioBridgeCommand = copyCommand(config.chrome.audioBridgeCommand);
  if (audioBridgeCommand) {
    startParams.audioBridgeCommand = audioBridgeCommand;
  }
  const audioBridgeHealthCommand = copyCommand(config.chrome.audioBridgeHealthCommand);
  if (audioBridgeHealthCommand) {
    startParams.audioBridgeHealthCommand = audioBridgeHealthCommand;
  }
  return approved(startParams);
}

function buildForwardParams(params: Record<string, unknown>): Record<string, unknown> | null {
  const action = readString(params.action);
  switch (action) {
    case "setup":
      return { action };
    case "status": {
      const bridgeId = readString(params.bridgeId);
      return bridgeId ? { action, bridgeId } : { action };
    }
    case "list": {
      const forwarded: Record<string, unknown> = { action };
      const url = readString(params.url);
      const mode = readString(params.mode);
      if (url) {
        forwarded.url = url;
      }
      if (mode) {
        forwarded.mode = mode;
      }
      return forwarded;
    }
    case "stopByUrl": {
      const forwarded: Record<string, unknown> = { action };
      const url = readString(params.url);
      const mode = readString(params.mode);
      const exceptBridgeId = readString(params.exceptBridgeId);
      if (url) {
        forwarded.url = url;
      }
      if (mode) {
        forwarded.mode = mode;
      }
      if (exceptBridgeId) {
        forwarded.exceptBridgeId = exceptBridgeId;
      }
      return forwarded;
    }
    case "pullAudio": {
      const forwarded: Record<string, unknown> = { action };
      const bridgeId = readString(params.bridgeId);
      const timeoutMs = readPositiveNumber(params.timeoutMs);
      if (bridgeId) {
        forwarded.bridgeId = bridgeId;
      }
      if (timeoutMs) {
        forwarded.timeoutMs = timeoutMs;
      }
      return forwarded;
    }
    case "pushAudio": {
      const forwarded: Record<string, unknown> = { action };
      const bridgeId = readString(params.bridgeId);
      const base64 = readString(params.base64);
      if (bridgeId) {
        forwarded.bridgeId = bridgeId;
      }
      if (base64) {
        forwarded.base64 = base64;
      }
      return forwarded;
    }
    case "clearAudio":
    case "stop": {
      const bridgeId = readString(params.bridgeId);
      return bridgeId ? { action, bridgeId } : { action };
    }
    default:
      return null;
  }
}

export function createGoogleMeetChromeNodeInvokePolicy(
  config: GoogleMeetConfig,
): OpenClawPluginNodeInvokePolicy {
  return {
    commands: [GOOGLE_MEET_CHROME_NODE_COMMAND],
    dangerous: true,
    async handle(ctx: OpenClawPluginNodeInvokePolicyContext) {
      if (ctx.command !== GOOGLE_MEET_CHROME_NODE_COMMAND) {
        return denied(`unsupported Google Meet node command: ${ctx.command}`);
      }
      const params = asRecord(ctx.params);
      const action = readString(params.action);
      let decision: PolicyDecision;
      if (action === "start") {
        decision = buildStartParams(params, config);
      } else {
        const forwardParams = buildForwardParams(params);
        decision = forwardParams
          ? approved(forwardParams)
          : { approved: false, result: denied("unsupported googlemeet.chrome action") };
      }
      if (!decision.approved) {
        return decision.result;
      }
      return await ctx.invokeNode({ params: decision.params });
    },
  };
}
