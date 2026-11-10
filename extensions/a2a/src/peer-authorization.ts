import { createHash, timingSafeEqual } from "node:crypto";
import { hasUnresolvedConfigValue } from "openclaw/plugin-sdk/gateway-config-runtime";
import type { PluginRuntime } from "openclaw/plugin-sdk/runtime-store";
import { DEFAULT_ACCOUNT_ID } from "./accounts.js";

type RuntimeConfig = ReturnType<PluginRuntime["config"]["current"]>;
export type A2aPeerAuthorization = Readonly<{
  peerName: string;
  isCurrent: () => boolean;
  assertCurrent: () => void;
}>;

export class A2aPeerAuthorizationError extends Error {
  constructor() {
    super("A2A peer authorization is no longer current");
    this.name = "A2aPeerAuthorizationError";
  }
}

function readPeerToken(config: RuntimeConfig, peerName: string): string | undefined {
  const channel = config.channels?.a2a;
  if (
    !channel ||
    channel.enabled === false ||
    hasUnresolvedConfigValue(config, ["channels", "a2a", "peers", peerName, "token"])
  ) {
    return undefined;
  }
  return channel.peers?.[peerName]?.token;
}

/** Bind a peer credential to its account owner; later effects read only published runtime facts. */
export function captureA2aPeerAuthorization(params: {
  authorization: string | undefined;
  accountId: string;
  readConfig: () => RuntimeConfig;
  signal: AbortSignal;
}): A2aPeerAuthorization | undefined {
  const { accountId, readConfig, signal } = params;
  // A2A publishes one default account. Another owner must never borrow its credentials.
  if (accountId !== DEFAULT_ACCOUNT_ID || signal.aborted) {
    return undefined;
  }
  const presented = params.authorization?.match(/^Bearer\s+([^\s]+)$/i)?.[1];
  if (!presented) {
    return undefined;
  }
  let config: RuntimeConfig;
  try {
    config = readConfig();
  } catch {
    return undefined;
  }
  const digest = createHash("sha256").update(presented).digest();
  for (const peerName of Object.keys(config.channels?.a2a?.peers ?? {})) {
    const token = readPeerToken(config, peerName);
    if (
      token === undefined ||
      !timingSafeEqual(digest, createHash("sha256").update(token).digest())
    ) {
      continue;
    }
    const isCurrent = () => {
      if (signal.aborted) {
        return false;
      }
      try {
        const current = readPeerToken(readConfig(), peerName);
        return (
          current !== undefined &&
          timingSafeEqual(digest, createHash("sha256").update(current).digest())
        );
      } catch {
        // A retired or unavailable config owner cannot authorize work or disclosure.
        return false;
      }
    };
    return {
      peerName,
      isCurrent,
      assertCurrent: () => {
        if (!isCurrent()) {
          throw new A2aPeerAuthorizationError();
        }
      },
    };
  }
  return undefined;
}
