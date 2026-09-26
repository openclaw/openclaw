// Venice video HTTP transport: stage-aware retries, deadline-bounded requests,
// and Venice's field-level error detail. Kept apart from request shaping so the
// provider module stays within the line cap.
import {
  assertOkOrThrowHttpError,
  executeProviderOperationWithRetry,
  type ProviderOperationDeadline,
  type ProviderOperationRetryStage,
  type TransientProviderRetryConfig,
  readProviderJsonResponse,
  resolveProviderOperationTimeoutMs,
} from "openclaw/plugin-sdk/provider-http";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { isRecord, normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { VENICE_ALLOWED_HOSTNAMES, VENICE_BASE_URL } from "./models.js";

const PROVIDER_ID = "venice";
const DEFAULT_HTTP_TIMEOUT_MS = 30_000;
export const VENICE_VIDEO_MALFORMED_RESPONSE = "venice video generation response malformed";

let veniceVideoFetchGuard = fetchWithSsrFGuard;

function setVeniceVideoFetchGuardForTesting(impl: typeof fetchWithSsrFGuard | null): void {
  veniceVideoFetchGuard = impl ?? fetchWithSsrFGuard;
}

// Test seam published through ./test-support.ts so production keeps no test-only exports.
if (process.env.VITEST === "true") {
  const key = Symbol.for("openclaw.veniceTestApi");
  // SAFETY: only this plugin's seam blocks write this global, always as a plain record of setters.
  const api = (Reflect.get(globalThis, key) as Record<string, unknown> | undefined) ?? {};
  Reflect.set(globalThis, key, { ...api, setVideoFetchGuard: setVeniceVideoFetchGuardForTesting });
}

export type VeniceVideoHttp = {
  headers: Record<string, string>;
  deadline: ProviderOperationDeadline;
};

// Every Venice call runs under the SDK transient-retry policy for its stage;
// a single 502 from Venice's edge during a multi-minute poll must not lose the job.
export async function fetchVeniceVideo(params: {
  url: string;
  init?: RequestInit;
  http: VeniceVideoHttp;
  stage: ProviderOperationRetryStage;
  retry?: TransientProviderRetryConfig;
  auditContext: string;
  errorContext: string;
  allowedHostnames?: string[];
}) {
  const resolveTimeoutMs = () =>
    resolveProviderOperationTimeoutMs({
      deadline: params.http.deadline,
      defaultTimeoutMs: DEFAULT_HTTP_TIMEOUT_MS,
    });
  // Deadline exhaustion is checked before entering the retry loop: the helper
  // treats timeout-shaped errors as transient, so an expired deadline raised
  // inside it would be retried instead of ending the operation.
  resolveTimeoutMs();
  // The retry sleeps are bounded by the same deadline through this signal, and
  // each attempt re-derives its request timeout from the remaining time.
  const deadlineAbort = createDeadlineAbort(params.http.deadline);
  try {
    return await executeProviderOperationWithRetry({
      provider: PROVIDER_ID,
      stage: params.stage,
      retry: params.retry,
      signal: deadlineAbort?.signal,
      operation: async () => {
        const result = await veniceVideoFetchGuard({
          url: params.url,
          init: params.init,
          timeoutMs: resolveTimeoutMs(),
          ...(params.allowedHostnames
            ? { policy: { allowedHostnames: params.allowedHostnames } }
            : {}),
          auditContext: params.auditContext,
        });
        try {
          await assertOkOrThrowHttpError(result.response, params.errorContext);
        } catch (error) {
          await result.release();
          throw withVeniceIssueDetail(error);
        }
        return result;
      },
    });
  } finally {
    deadlineAbort?.dispose();
  }
}

function createDeadlineAbort(
  deadline: ProviderOperationDeadline,
): { signal: AbortSignal; dispose: () => void } | undefined {
  if (typeof deadline.deadlineAtMs !== "number") {
    return undefined;
  }
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error(`${deadline.label} timed out`)),
    Math.max(1, deadline.deadlineAtMs - Date.now()),
  );
  timer.unref?.();
  return { signal: controller.signal, dispose: () => clearTimeout(timer) };
}

// Venice 400s carry a zod-style `issues` list naming the offending field; the
// generic "Invalid request parameters" message hides it from the agent.
function withVeniceIssueDetail(error: unknown): unknown {
  const body = isRecord(error) ? error.errorBody : undefined;
  if (!(error instanceof Error) || typeof body !== "string") {
    return error;
  }
  let issues: unknown;
  try {
    const parsed: unknown = JSON.parse(body);
    issues = isRecord(parsed) ? parsed.issues : undefined;
  } catch {
    return error;
  }
  if (!Array.isArray(issues) || issues.length === 0) {
    return error;
  }
  const detail = issues
    .filter(isRecord)
    .map((issue) => {
      const path = Array.isArray(issue.path) ? issue.path.join(".") : "";
      const message = normalizeOptionalString(issue.message) ?? "invalid";
      return path ? `${path}: ${message}` : message;
    })
    .join("; ");
  return detail ? new Error(`${error.message} (${detail})`, { cause: error }) : error;
}

export async function postVeniceJson(params: {
  path: string;
  body: Record<string, unknown>;
  http: VeniceVideoHttp;
  stage: ProviderOperationRetryStage;
  retry?: TransientProviderRetryConfig;
  auditContext: string;
  errorContext: string;
}) {
  return await fetchVeniceVideo({
    url: `${VENICE_BASE_URL}${params.path}`,
    init: {
      method: "POST",
      headers: params.http.headers,
      body: JSON.stringify(params.body),
    },
    http: params.http,
    stage: params.stage,
    retry: params.retry,
    auditContext: params.auditContext,
    errorContext: params.errorContext,
    allowedHostnames: VENICE_ALLOWED_HOSTNAMES,
  });
}

export async function readVeniceJson(response: Response, errorContext: string): Promise<unknown> {
  try {
    return await readProviderJsonResponse<unknown>(response, errorContext);
  } catch (error) {
    if (error instanceof Error && error.message.endsWith(": malformed JSON response")) {
      throw new Error(VENICE_VIDEO_MALFORMED_RESPONSE, { cause: error });
    }
    throw error;
  }
}
