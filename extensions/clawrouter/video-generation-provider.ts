import { randomUUID } from "node:crypto";
import type {
  UnifiedModelCatalogEntry,
  UnifiedModelCatalogProviderContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { resolveApiKeyForProvider } from "openclaw/plugin-sdk/provider-auth-runtime";
import {
  createProviderOperationDeadline,
  createProviderOperationTimeoutResolver,
  pollProviderOperation,
} from "openclaw/plugin-sdk/provider-http";
import { readResponseWithLimit } from "openclaw/plugin-sdk/response-limit-runtime";
import { sleepWithAbort } from "openclaw/plugin-sdk/retry-runtime";
import { fetchWithSsrFGuard, mergeSsrFPolicies } from "openclaw/plugin-sdk/ssrf-runtime";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  buildDashscopeVideoGenerationInput,
  buildDashscopeVideoGenerationParameters,
  DASHSCOPE_WAN_VIDEO_CAPABILITIES,
  extractDashscopeVideoUrls,
  recordModelFallbackStop,
  type VideoGenerationProvider,
  type VideoGenerationRequest,
} from "openclaw/plugin-sdk/video-generation";
import {
  fetchClawRouterCapabilityOffers,
  resolveClawRouterCapabilityHttpContext,
  type ClawRouterCapabilityOffer,
} from "./capability-offers.js";

const MODEL = "alibaba/wan2.6-t2v";
const UPSTREAM = "wan2.6-t2v";
const CREATE_PATH = "/api/v1/services/aigc/video-generation/video-synthesis";
const TASK_PATH = "/api/v1/tasks/${task_id}";
const JSON_LIMIT = 1024 * 1024;
const TIMEOUT_MS = 120_000;
const capabilities = {
  generate: DASHSCOPE_WAN_VIDEO_CAPABILITIES.generate,
  imageToVideo: { enabled: false },
  videoToVideo: { enabled: false },
} satisfies VideoGenerationProvider["capabilities"];

function qualified(offer: ClawRouterCapabilityOffer): boolean {
  const controls = offer.declaredRoutes?.filter((route) => route.endpoint === "task");
  const task = controls?.length === 1 ? controls[0] : undefined;
  return (
    offer.providerId === "alibaba" &&
    offer.endpoint === "video" &&
    offer.path === CREATE_PATH &&
    offer.model?.id === MODEL &&
    offer.model.upstream === UPSTREAM &&
    Array.isArray(offer.model.capabilities) &&
    offer.model.capabilities.includes("media.predict") &&
    offer.requestFormat === "dashscope.video_create" &&
    offer.responseFormat === "dashscope.video" &&
    offer.methods.length === 1 &&
    offer.methods[0] === "POST" &&
    (offer.routeKind === "native" || offer.routeKind === "manifest") &&
    task?.path === TASK_PATH &&
    task.requestFormat === "dashscope.video_get" &&
    task.responseFormat === "dashscope.video" &&
    Array.isArray(task.methods) &&
    task.methods.length === 1 &&
    task.methods[0] === "GET"
  );
}

function contextFor(req: Pick<VideoGenerationRequest, "cfg">, apiKey: string) {
  if (req.cfg.models?.providers?.clawrouter?.request?.auth) {
    throw new Error("ClawRouter video requires the selected proxy key without an auth override.");
  }
  const context = resolveClawRouterCapabilityHttpContext(req.cfg, apiKey);
  for (const name of [
    "x-api-key",
    "x-dashscope-api-key",
    "x-goog-api-key",
    "x-clawrouter-job-id",
  ]) {
    context.headers.delete(name);
  }
  return context;
}

export async function listClawRouterVideoModelCatalog(
  ctx: UnifiedModelCatalogProviderContext,
): Promise<UnifiedModelCatalogEntry[]> {
  const selected = ctx.resolveProviderAuth("clawrouter");
  if (!selected.apiKey && !selected.discoveryApiKey && !selected.profileId) {
    return [];
  }
  const auth = await resolveApiKeyForProvider({
    provider: "clawrouter",
    cfg: ctx.config,
    agentDir: ctx.agentDir,
    workspaceDir: ctx.workspaceDir,
    signal: ctx.signal,
    ...(selected.profileId ? { profileId: selected.profileId, lockedProfile: true } : {}),
  });
  if (!auth.apiKey) {
    return [];
  }
  const offers = await fetchClawRouterCapabilityOffers({
    context: contextFor({ cfg: ctx.config }, auth.apiKey),
    timeoutMs: () => ctx.timeoutMs ?? 5_000,
    signal: ctx.signal,
    requireFreshProxyCatalog: true,
    includeDeclaredRoutes: true,
  });
  return offers.some(qualified)
    ? [
        {
          kind: "video_generation",
          provider: "clawrouter",
          model: MODEL,
          label: "Wan 2.6 via ClawRouter",
          source: "live",
          modes: ["generate"],
          capabilities,
        },
      ]
    : [];
}

function prepare(req: VideoGenerationRequest) {
  const mode = capabilities.generate;
  if (
    req.model !== MODEL ||
    !req.prompt.trim() ||
    /\p{Surrogate}/u.test(req.prompt) ||
    [...req.prompt].length > 1500
  ) {
    throw new Error(
      "ClawRouter Wan requires the qualified model and 1-1500 valid prompt characters.",
    );
  }
  if (
    req.inputImages?.length ||
    req.inputVideos?.length ||
    req.inputAudios?.length ||
    (req.providerOptions && Object.keys(req.providerOptions).length)
  ) {
    throw new Error(
      "ClawRouter Wan supports text-only generation; reference assets and provider options are not qualified.",
    );
  }
  if (
    (req.durationSeconds !== undefined &&
      (!Number.isInteger(req.durationSeconds) ||
        req.durationSeconds < 2 ||
        req.durationSeconds > 15)) ||
    (req.size !== undefined && !mode.sizes.includes(req.size)) ||
    (req.aspectRatio !== undefined &&
      !mode.aspectRatios.some((value) => value === req.aspectRatio)) ||
    (req.resolution !== undefined && !mode.resolutions.some((value) => value === req.resolution))
  ) {
    throw new Error("Unsupported ClawRouter Wan duration or geometry.");
  }
  const native = { ...req, model: UPSTREAM, durationSeconds: req.durationSeconds ?? 5 };
  return {
    model: UPSTREAM,
    input: buildDashscopeVideoGenerationInput({ providerLabel: "ClawRouter Wan", req: native }),
    parameters: buildDashscopeVideoGenerationParameters(native),
  };
}

function readObservation(payload: unknown, expectedId?: string) {
  const root = asOptionalRecord(payload),
    output = asOptionalRecord(root?.output);
  const id = output?.task_id,
    status = output?.task_status;
  if (
    !root ||
    !output ||
    (root.code !== undefined && root.code !== "") ||
    typeof id !== "string" ||
    !/^[A-Za-z0-9_-]{1,128}$/u.test(id) ||
    (expectedId !== undefined && id !== expectedId) ||
    typeof status !== "string" ||
    !["PENDING", "RUNNING", "SUCCEEDED", "FAILED", "CANCELED", "UNKNOWN"].includes(status)
  ) {
    throw new Error(
      "ClawRouter Wan returned an invalid or foreign task observation; do not replay creation.",
    );
  }
  if (status === "UNKNOWN") {
    throw new Error(
      "ClawRouter Wan observation is unavailable; stop polling and reconcile the original task.",
    );
  }
  if (status === "FAILED" || status === "CANCELED") {
    throw new Error(`ClawRouter Wan task is ${status}; this does not establish a refund.`);
  }
  if (status !== "SUCCEEDED") {
    return { id, status, url: undefined };
  }
  if (
    (output.video_url !== undefined && typeof output.video_url !== "string") ||
    (output.results !== undefined && (!Array.isArray(output.results) || output.results.length > 1))
  ) {
    throw new Error("ClawRouter Wan returned an invalid video result.");
  }
  const results: Array<{ video_url: string }> = [];
  for (const value of Array.isArray(output.results) ? output.results : []) {
    const result = asOptionalRecord(value);
    if (typeof result?.video_url !== "string") {
      throw new Error("ClawRouter Wan returned an invalid video result.");
    }
    results.push({ video_url: result.video_url });
  }
  const urls = extractDashscopeVideoUrls({
    output: {
      results,
      ...(typeof output.video_url === "string" ? { video_url: output.video_url } : {}),
    },
  });
  if (urls.length !== 1 || urls[0]!.length > 8192) {
    throw new Error(
      "ClawRouter Wan completed without exactly one deliverable; do not replay creation.",
    );
  }
  let url: URL;
  try {
    url = new URL(urls[0]!);
  } catch {
    throw new Error("ClawRouter Wan returned an invalid output URL.");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    throw new Error("ClawRouter Wan returned an unsafe output URL.");
  }
  return { id, status, url: url.href };
}

export function buildClawRouterVideoGenerationProvider(): VideoGenerationProvider {
  return {
    id: "clawrouter",
    label: "ClawRouter",
    models: [],
    capabilities,
    async generateVideo(req) {
      req.signal?.throwIfAborted();
      const body = prepare(req);
      const remaining = createProviderOperationTimeoutResolver({
        deadline: createProviderOperationDeadline({
          timeoutMs: req.timeoutMs ?? TIMEOUT_MS,
          label: "ClawRouter video",
        }),
        defaultTimeoutMs: TIMEOUT_MS,
      });
      const auth = await resolveApiKeyForProvider({
        provider: "clawrouter",
        cfg: req.cfg,
        agentDir: req.agentDir,
        store: req.authStore,
        modelId: req.model,
        signal: req.signal,
      });
      if (!auth.apiKey) {
        throw new Error("ClawRouter proxy key missing; native Alibaba credentials are not used.");
      }
      const context = contextFor(req, auth.apiKey);
      const offers = await fetchClawRouterCapabilityOffers({
        context,
        timeoutMs: remaining,
        signal: req.signal,
        requireFreshProxyCatalog: true,
        includeDeclaredRoutes: true,
      });
      const candidates = offers.filter(qualified);
      const selected = candidates.find((offer) => offer.routeKind === "native") ?? candidates[0];
      if (!selected) {
        throw new Error(
          "ClawRouter Wan offer or original-task GET declaration is absent or unsupported.",
        );
      }
      const wire = JSON.stringify(selected.routeKind === "manifest" ? { body } : body);
      if (Buffer.byteLength(wire) > JSON_LIMIT) {
        throw new Error("ClawRouter Wan request exceeds 1 MiB.");
      }
      const headers = new Headers(context.headers);
      headers.set("Idempotency-Key", randomUUID());
      let attempted = false,
        jobId: string | undefined;
      const request = async (url: string, create: boolean) => {
        req.signal?.throwIfAborted();
        const currentHeaders = new Headers(headers);
        if (create) {
          currentHeaders.set("Content-Type", "application/json");
          currentHeaders.set("X-DashScope-Async", "enable");
        }
        if (jobId) {
          currentHeaders.set("x-clawrouter-job-id", jobId);
        }
        const { response, release } = await fetchWithSsrFGuard({
          url,
          init: {
            method: create ? "POST" : "GET",
            headers: currentHeaders,
            ...(create ? { body: wire } : {}),
            signal: req.signal,
          },
          beforeRequest: () => {
            req.signal?.throwIfAborted();
            if (create) {
              attempted = true;
            }
          },
          timeoutMs: remaining(),
          maxRedirects: 0,
          policy: mergeSsrFPolicies(
            context.ssrfPolicy,
            context.allowPrivateNetwork ? { allowPrivateNetwork: true } : undefined,
          ),
          dispatcherPolicy: context.dispatcherPolicy,
          auditContext: "clawrouter.video",
        });
        try {
          if (
            response.status !== 200 ||
            response.redirected ||
            response.headers.has("content-range") ||
            ![null, "identity"].includes(response.headers.get("content-encoding")) ||
            response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !==
              "application/json"
          ) {
            throw new Error(
              `ClawRouter Wan returned HTTP ${response.status}; do not replay creation.`,
            );
          }
          const returnedJob = response.headers.get("x-clawrouter-job-id");
          if (create) {
            if (!returnedJob || !/^[A-Za-z0-9_-]{1,128}$/u.test(returnedJob)) {
              throw new Error("ClawRouter Wan response has no original-job selector.");
            }
            jobId = returnedJob;
          } else if (returnedJob !== null && returnedJob !== jobId) {
            throw new Error("ClawRouter Wan response changed the original job.");
          }
          const bytes = await readResponseWithLimit(response, JSON_LIMIT, {
            timeoutMs: remaining,
            signal: req.signal,
          });
          const length = response.headers.get("content-length");
          if (length !== null && (!/^\d+$/u.test(length) || Number(length) !== bytes.length)) {
            throw new Error("ClawRouter Wan response ended with a mismatched length.");
          }
          try {
            return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
          } catch {
            throw new Error(
              "ClawRouter Wan returned malformed UTF-8 JSON; do not replay creation.",
            );
          }
        } finally {
          void response.body?.cancel().catch(() => undefined);
          await release();
        }
      };
      try {
        let observation = readObservation(await request(selected.url, true));
        const id = observation.id;
        const root = context.baseUrl.replace(/\/v1\/?$/u, "");
        const controlUrl =
          selected.routeKind === "native"
            ? `${root}/v1/native/alibaba/api/v1/tasks/${encodeURIComponent(id)}`
            : `${root}/v1/proxy/alibaba/task?${new URLSearchParams({ task_id: id })}`;
        if (!observation.url) {
          observation = await pollProviderOperation({
            read: async () => readObservation(await request(controlUrl, false), id),
            isComplete: (value) => value.url !== undefined,
            wait: () => sleepWithAbort(Math.min(2500, remaining()), req.signal),
            maxAttempts: 120,
            timeoutMessage:
              "ClawRouter Wan polling limit reached; reconcile the original task without replay.",
          });
        }
        if (!observation.url) {
          throw new Error("ClawRouter Wan has no deliverable video.");
        }
        // Wan declares opaque public media URLs, not authenticated router file controls.
        // Do not send credentials or infer a download grant from this result.
        if (new URL(observation.url).origin === new URL(context.baseUrl).origin) {
          throw new Error("ClawRouter Wan has no qualified authenticated file delivery operation.");
        }
        req.signal?.throwIfAborted();
        return {
          model: req.model,
          videos: [{ url: observation.url, mimeType: "video/mp4" }],
          metadata: { taskId: id, taskStatus: observation.status },
        };
      } catch (cause) {
        const error =
          cause instanceof Error ? cause : new Error("ClawRouter video failed", { cause });
        // Replay policy only; neither terminal delivery nor cancellation decides billing/refund.
        if (attempted) {
          recordModelFallbackStop(error);
        }
        throw error;
      }
    },
  };
}
