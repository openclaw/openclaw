import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

export const CODEX_NODE_GITHUB_REFRESH_FEATURE = "github-profile-refresh";
export type CodexNodeGitHubRefresh = {
  type: "openclaw.github.profile";
  generation: number;
  token: string;
  expiresAtMs?: number;
};
export type CodexNodeGitHubRefreshAck = {
  type: "openclaw.github.profile.ack";
  generation: number;
  ok: boolean;
};
export function parseCodexNodeGitHubControl(
  message: Uint8Array,
): CodexNodeGitHubRefresh | CodexNodeGitHubRefreshAck | undefined {
  if (message[0] !== 0) {
    return undefined;
  }
  if (message.length > 8192) {
    throw new Error("Node GitHub control frame exceeds its budget");
  }
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(message.subarray(1)).toString("utf8"));
  } catch {
    throw new Error("Invalid node GitHub control frame");
  }
  if (
    !isRecord(value) ||
    !Number.isSafeInteger(value.generation) ||
    typeof value.generation !== "number" ||
    value.generation < 1
  ) {
    return undefined;
  }
  if (
    value.type === "openclaw.github.profile" &&
    Object.keys(value).length === (value.expiresAtMs === undefined ? 3 : 4) &&
    typeof value.token === "string" &&
    value.token.length > 0 &&
    value.token.length <= 4096 &&
    (value.expiresAtMs === undefined ||
      (typeof value.expiresAtMs === "number" &&
        Number.isSafeInteger(value.expiresAtMs) &&
        value.expiresAtMs > 0))
  ) {
    return {
      type: value.type,
      generation: value.generation,
      token: value.token,
      expiresAtMs: value.expiresAtMs,
    };
  }
  if (
    value.type === "openclaw.github.profile.ack" &&
    Object.keys(value).length === 3 &&
    typeof value.ok === "boolean"
  ) {
    return { type: value.type, generation: value.generation, ok: value.ok };
  }
  throw new Error("Invalid node GitHub control frame");
}

/** Private payloads stay outside native Codex JSON-RPC while retaining v1 duplex framing. */
export function encodeCodexNodeGitHubControl(
  value: CodexNodeGitHubRefresh | CodexNodeGitHubRefreshAck,
): Buffer {
  return Buffer.concat([Buffer.from([0]), Buffer.from(JSON.stringify(value))]);
}
