import {
  browserClientTimeout,
  requestBrowserJson,
  type BrowserClientTarget,
} from "./client-request.js";

/** Close a canonical raw target id selected by OpenClaw's internal tab bookkeeping. */
export async function browserCloseTabByRawTargetId(
  baseUrl: BrowserClientTarget,
  targetId: string,
  opts?: { profile?: string; timeoutMs?: number; signal?: AbortSignal },
): Promise<void> {
  const path = `/tabs/${encodeURIComponent(targetId)}?targetIdMode=raw`;
  await requestBrowserJson(baseUrl, path, {
    profile: opts?.profile,
    method: "DELETE",
    timeoutMs: browserClientTimeout(baseUrl, opts?.timeoutMs, 5000),
    signal: opts?.signal,
  });
}
