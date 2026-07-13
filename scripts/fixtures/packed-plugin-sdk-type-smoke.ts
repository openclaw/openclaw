// Packed Plugin Sdk Type Smoke script supports OpenClaw repository automation.
import type { NodeSession } from "openclaw/plugin-sdk/gateway-runtime";
import { ErrorCodes, errorShape } from "openclaw/plugin-sdk/gateway-runtime";

type PublicPluginSdkModules = [
  typeof import("openclaw/plugin-sdk"),
  typeof import("openclaw/plugin-sdk/channel-entry-contract"),
  typeof import("openclaw/plugin-sdk/config-contracts"),
  typeof import("openclaw/plugin-sdk/gateway-runtime"),
  typeof import("openclaw/plugin-sdk/provider-entry"),
  typeof import("openclaw/plugin-sdk/runtime-env"),
];

const resolvedModules = null as unknown as PublicPluginSdkModules;

void resolvedModules;

const nodeSession = null as unknown as NodeSession;

nodeSession.nodeId satisfies string;
nodeSession.connId satisfies string;
nodeSession.declaredCaps satisfies string[];
nodeSession.caps satisfies string[];
nodeSession.declaredCommands satisfies string[];
nodeSession.commands satisfies string[];
nodeSession.connectedAtMs satisfies number;

const unavailableCode = ErrorCodes.UNAVAILABLE;
unavailableCode satisfies (typeof ErrorCodes)[keyof typeof ErrorCodes];

const unavailable = errorShape(unavailableCode, "gateway unavailable", {
  retryable: true,
  retryAfterMs: 250,
});

unavailable.code satisfies string;
unavailable.message satisfies string;
unavailable.retryable satisfies boolean | undefined;
