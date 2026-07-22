/**
 * Fetches and extracts clean text from an untrusted external URL, routing
 * the actual network fetch + HTML parsing through the calling agent's
 * Docker sandbox container when one exists (via the sandbox-exec bridge
 * registry), instead of the gateway's own process. Falls back to
 * in-process fetch+extract for agents with no sandbox -- this keeps the
 * primitive a strict drop-in upgrade for existing unsandboxed callers.
 *
 * SSRF/destination validation always happens host-side first (evaluating a
 * URL string carries none of the risk this module exists to contain,
 * unlike parsing the untrusted response body).
 */
import { fetchWithSsrFGuard } from "../../infra/net/fetch-guard.js";
import { resolvePinnedHostnameWithPolicy, SsrFBlockedError } from "../../infra/net/ssrf.js";
import { getSandboxExecBridge } from "./exec-bridge-registry.js";
import { extractCleanTextCore } from "./sandboxed-fetch-extract.js";

const SANDBOXED_FETCH_SCRIPT_PATH = "/usr/local/bin/openclaw-sandboxed-fetch.py";
const SANDBOXED_FETCH_TIMEOUT_MS = 20_000;

export type FetchAndExtractSandboxedResult = { text: string } | { error: string };

export async function fetchAndExtractSandboxed(params: {
  url: string;
  maxChars: number;
  sandboxExecKey?: string;
}): Promise<FetchAndExtractSandboxedResult> {
  let parsed: URL;
  try {
    parsed = new URL(params.url);
  } catch {
    return { error: "Blocked: not a valid URL" };
  }

  let pinnedIp: string | undefined;
  try {
    const pinned = await resolvePinnedHostnameWithPolicy(parsed.hostname);
    pinnedIp = pinned.addresses[0];
  } catch (err) {
    return { error: `Blocked: ${err instanceof Error ? err.message : String(err)}` };
  }

  const bridge = params.sandboxExecKey ? getSandboxExecBridge(params.sandboxExecKey) : undefined;

  if (!bridge) {
    // No sandbox for this agent -- fall back to today's in-process behavior.
    try {
      const { response, release } = await fetchWithSsrFGuard({
        url: params.url,
        timeoutMs: SANDBOXED_FETCH_TIMEOUT_MS,
      });
      try {
        if (!response.ok) {
          return { error: `HTTP ${response.status} fetching ${params.url}` };
        }
        const html = await response.text();
        return { text: extractCleanTextCore(html, params.maxChars) };
      } finally {
        await release();
      }
    } catch (err) {
      if (err instanceof SsrFBlockedError) {
        return { error: `Blocked: ${err.message}` };
      }
      return { error: `Fetch failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  // Sandboxed: dispatch the actual fetch+parse into the container. A
  // runShellCommand-level failure here is an infra failure, not a
  // fetch-level one -- it must NOT silently fall back to the unsandboxed
  // path above, since that would quietly defeat the whole point of this
  // module the first time the container has a hiccup.
  let result: Awaited<ReturnType<typeof bridge.runShellCommand>>;
  try {
    result = await bridge.runShellCommand({
      script: `python3 "${SANDBOXED_FETCH_SCRIPT_PATH}" "$1" "$2" "$3"`,
      args: [params.url, String(params.maxChars), pinnedIp ?? ""],
      allowFailure: true,
    });
  } catch (err) {
    return { error: `Sandboxed fetch failed: ${err instanceof Error ? err.message : String(err)}` };
  }

  const stdout = result.stdout.toString("utf8").trim();
  let parsedResult: { ok: boolean; text?: string; error?: string };
  try {
    parsedResult = JSON.parse(stdout);
  } catch {
    const stderr = result.stderr.toString("utf8").trim();
    return {
      error: `Sandboxed fetch failed: non-JSON output (code ${result.code}): ${stderr || stdout || "(empty)"}`,
    };
  }

  if (!parsedResult.ok) {
    return { error: parsedResult.error ?? "Sandboxed fetch failed: unknown error" };
  }
  return { text: parsedResult.text ?? "" };
}
