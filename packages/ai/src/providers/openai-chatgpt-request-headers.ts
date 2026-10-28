import type * as NodeOs from "node:os";
import { omitNullRequestHeaders, type ModelRequestHeaders } from "@openclaw/llm-core";
import { mergeTransportHeaders } from "../transports/transport-stream-shared.js";

function loadNodeOs(): typeof NodeOs | null {
  if (typeof process === "undefined" || !(process.versions?.node || process.versions?.bun)) {
    return null;
  }
  return process.getBuiltinModule?.("node:os") ?? null;
}

// Keep Node builtins out of the runtime import graph for browser consumers.
const os = loadNodeOs();

export function buildBaseCodexHeaders(
  initHeaders: ModelRequestHeaders | undefined,
  additionalHeaders: ModelRequestHeaders | undefined,
  accountId: string,
  token: string,
): Headers {
  const headers = new Headers(
    omitNullRequestHeaders(mergeTransportHeaders(initHeaders, additionalHeaders)),
  );
  headers.set("Authorization", `Bearer ${token}`);
  headers.set("chatgpt-account-id", accountId);
  headers.set("originator", "openclaw");
  const userAgent = os
    ? `openclaw (${os.platform()} ${os.release()}; ${os.arch()})`
    : "openclaw (browser)";
  headers.set("User-Agent", userAgent);
  return headers;
}
