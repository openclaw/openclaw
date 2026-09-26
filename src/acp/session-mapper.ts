/** Resolves ACP request metadata into OpenClaw Gateway session keys and reset behavior. */
import { readBool, readMetadataString } from "@openclaw/acp-core/meta";
import type { AcpServerOptions } from "@openclaw/acp-core/types";
import type { GatewayClient } from "../gateway/client.js";

type AcpSessionMeta = {
  sessionKey?: string;
  sessionLabel?: string;
  resetSession?: boolean;
  requireExisting?: boolean;
  prefixCwd?: boolean;
};

/** Parses ACP request metadata into OpenClaw session routing hints. */
export function parseSessionMeta(meta: unknown): AcpSessionMeta {
  if (!meta || typeof meta !== "object") {
    return {};
  }
  const record = meta as Record<string, unknown>;
  return {
    sessionKey: readMetadataString(record, ["sessionKey", "session", "key"]),
    sessionLabel: readMetadataString(record, ["sessionLabel", "label"]),
    resetSession: readBool(record, ["resetSession", "reset"]),
    requireExisting: readBool(record, ["requireExistingSession", "requireExisting"]),
    prefixCwd: readBool(record, ["prefixCwd"]),
  };
}

/** Resolves the Gateway session key for an ACP request using metadata, defaults, or fallback. */
export async function resolveAcpSessionKey(params: {
  meta: AcpSessionMeta;
  fallbackKey: string;
  gateway: GatewayClient;
  opts: AcpServerOptions;
}): Promise<string> {
  // A per-session key outranks the server's default label.
  const requestedLabel =
    params.meta.sessionLabel ??
    (params.meta.sessionKey ? undefined : params.opts.defaultSessionLabel);
  const requestedKey = params.meta.sessionKey ?? params.opts.defaultSessionKey;
  const requireExisting =
    params.meta.requireExisting ?? params.opts.requireExistingSession ?? false;

  if (requestedLabel) {
    const resolved = await params.gateway.request<{ ok: true; key: string }>("sessions.resolve", {
      label: requestedLabel,
    });
    if (!resolved?.key) {
      throw new Error(`Unable to resolve session label: ${requestedLabel}`);
    }
    return resolved.key;
  }

  if (requestedKey) {
    if (!requireExisting) {
      return requestedKey;
    }
    const resolved = await params.gateway.request<{ ok: true; key: string }>("sessions.resolve", {
      key: requestedKey,
    });
    if (!resolved?.key) {
      throw new Error(`Session key not found: ${requestedKey}`);
    }
    return resolved.key;
  }

  return params.fallbackKey;
}

/** Sends a Gateway session reset when ACP metadata or server defaults request it. */
export async function resetSessionIfNeeded(params: {
  meta: AcpSessionMeta;
  sessionKey: string;
  gateway: GatewayClient;
  opts: AcpServerOptions;
}): Promise<void> {
  const resetSession = params.meta.resetSession ?? params.opts.resetSession ?? false;
  if (!resetSession) {
    return;
  }
  await params.gateway.request("sessions.reset", { key: params.sessionKey });
}
