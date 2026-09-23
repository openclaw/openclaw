// Device Pair plugin module implements pair command auth behavior.
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";

type ResolveAuthLabelResult = {
  label?: "token" | "password" | "trusted-proxy";
  error?: string;
};

type PairingCommandAuthParams = {
  channel: string;
  gatewayClientScopes?: readonly string[] | null;
  senderIsOwner?: boolean;
};

type PairingCommandAuthState = {
  isInternalGatewayCaller: boolean;
  isMissingPairingPrivilege: boolean;
  isMissingSetupHandoffPrivilege: boolean;
  canIssueFullAccessSetup: boolean;
  approvalCallerScopes?: readonly string[];
};

const COMMAND_OWNER_PAIRING_SCOPES = ["operator.pairing"] as const;
const PAIRING_SCOPE = "operator.pairing";
const ADMIN_SCOPE = "operator.admin";
const TALK_SECRETS_SCOPE = "operator.talk.secrets";

export function resolveAuthLabel(cfg: OpenClawPluginApi["config"]): ResolveAuthLabelResult {
  const mode = cfg.gateway?.auth?.mode;
  const token =
    pickFirstDefined([process.env.OPENCLAW_GATEWAY_TOKEN, cfg.gateway?.auth?.token]) ?? undefined;
  const password =
    pickFirstDefined([process.env.OPENCLAW_GATEWAY_PASSWORD, cfg.gateway?.auth?.password]) ??
    undefined;

  if (mode === "token" || mode === "password") {
    return resolveRequiredAuthLabel(mode, { token, password });
  }
  if (token) {
    return { label: "token" };
  }
  if (password) {
    return { label: "password" };
  }
  // Issuer authorization and bootstrap grants stay separate from ingress auth.
  if (mode === "trusted-proxy") {
    return { label: "trusted-proxy" };
  }
  return { error: "Gateway auth is not configured (no token or password)." };
}

function pickFirstDefined(candidates: Array<unknown>): string | null {
  for (const value of candidates) {
    const trimmed = normalizeOptionalString(value);
    if (trimmed) {
      return trimmed;
    }
  }
  return null;
}

function resolveRequiredAuthLabel(
  mode: "token" | "password",
  values: { token?: string; password?: string },
): ResolveAuthLabelResult {
  if (mode === "token") {
    return values.token
      ? { label: "token" }
      : { error: "Gateway auth is set to token, but no token is configured." };
  }
  return values.password
    ? { label: "password" }
    : { error: "Gateway auth is set to password, but no password is configured." };
}

function isInternalGatewayPairingCaller(params: PairingCommandAuthParams): boolean {
  return params.channel === "webchat" || Array.isArray(params.gatewayClientScopes);
}

function hasPairingPrivilege(scopes: readonly string[]): boolean {
  return scopes.includes(PAIRING_SCOPE) || scopes.includes(ADMIN_SCOPE);
}

function hasSetupHandoffPrivilege(scopes: readonly string[]): boolean {
  return scopes.includes(TALK_SECRETS_SCOPE) || scopes.includes(ADMIN_SCOPE);
}

export function resolvePairingCommandAuthState(
  params: PairingCommandAuthParams,
): PairingCommandAuthState {
  const isInternalGatewayCaller = isInternalGatewayPairingCaller(params);
  if (isInternalGatewayCaller) {
    const approvalCallerScopes = Array.isArray(params.gatewayClientScopes)
      ? params.gatewayClientScopes
      : [];
    return {
      isInternalGatewayCaller,
      isMissingPairingPrivilege: !hasPairingPrivilege(approvalCallerScopes),
      isMissingSetupHandoffPrivilege: !hasSetupHandoffPrivilege(approvalCallerScopes),
      canIssueFullAccessSetup: approvalCallerScopes.includes(ADMIN_SCOPE),
      approvalCallerScopes,
    };
  }

  if (params.senderIsOwner === true) {
    return {
      isInternalGatewayCaller,
      isMissingPairingPrivilege: false,
      isMissingSetupHandoffPrivilege: false,
      canIssueFullAccessSetup: true,
      approvalCallerScopes: COMMAND_OWNER_PAIRING_SCOPES,
    };
  }

  return {
    isInternalGatewayCaller,
    isMissingPairingPrivilege: true,
    isMissingSetupHandoffPrivilege: true,
    canIssueFullAccessSetup: false,
    approvalCallerScopes: undefined,
  };
}

export function buildMissingPairingScopeReply(): { text: string } {
  return {
    text: "⚠️ This command requires operator.pairing.",
  };
}

export function buildMissingSetupHandoffScopeReply(): { text: string } {
  return {
    text: "⚠️ Setup code handoff includes Talk secrets and requires operator.talk.secrets.",
  };
}
