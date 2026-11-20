import { createMediaGenerationTerminalError } from "openclaw/plugin-sdk/media-generation-runtime";
import { resolveApiKeyForProvider } from "openclaw/plugin-sdk/provider-auth-runtime";
import {
  createProviderOperationDeadline,
  createProviderOperationTimeoutResolver,
  fetchWithTimeoutGuarded,
  pollProviderOperation,
  postMultipartRequest,
  readProviderJsonResponse,
  waitProviderOperationPollInterval,
} from "openclaw/plugin-sdk/provider-http";
import { fetchWithRuntimeDispatcher } from "openclaw/plugin-sdk/runtime-fetch";
import type { VideoGenerationProvider } from "openclaw/plugin-sdk/video-generation";
import {
  fetchClawRouterCapabilityOffers,
  resolveClawRouterCapabilityHttpContext,
} from "./capability-offers.js";
import {
  isPixVerseImageOffer,
  PIXVERSE_IMAGE_PATH,
  PIXVERSE_VIDEO_CAPABILITIES,
  preparePixVerseMultipart,
  readPixVerseEnvelope,
  readPixVerseId,
  readPixVerseStatus,
} from "./video-pixverse.js";

const DEFAULT_TIMEOUT_MS = 300_000;
const fetchWithoutRedirects: typeof fetch = (input, init) =>
  fetchWithRuntimeDispatcher(input, { ...init, redirect: "error" });

/** Keep both body and release failures, including independently thrown undefined values. */
async function readOwnedResponse(
  owned: { response: Response; release: () => Promise<void> },
  remaining: () => number,
  headers: Headers,
): Promise<unknown> {
  const errors: unknown[] = [];
  let payload: unknown;
  try {
    const { response } = owned;
    if (response.status !== 200 || response.redirected) {
      throw new Error(
        `ClawRouter PixVerse request failed (HTTP ${response.status}); no create replay is permitted.`,
      );
    }
    const encoding = response.headers.get("content-encoding");
    if (encoding && encoding.toLowerCase() !== "identity") {
      throw new Error("ClawRouter PixVerse requires an identity-encoded JSON response.");
    }
    payload = await readProviderJsonResponse(response, "ClawRouter PixVerse", {
      maxBytes: 1024 * 1024,
      timeoutMs: remaining,
      requestHeaders: headers,
    });
    remaining();
  } catch (error) {
    errors.push(error);
  }
  try {
    await owned.response.body?.cancel();
  } catch (error) {
    errors.push(error);
  }
  try {
    await owned.release();
  } catch (error) {
    errors.push(error);
  }
  if (errors.length === 1) {
    throw errors[0];
  }
  if (errors.length > 1) {
    throw new AggregateError(errors, "ClawRouter PixVerse response and cleanup failed.");
  }
  return payload;
}

export function buildClawRouterVideoGenerationProvider(): VideoGenerationProvider {
  return {
    id: "clawrouter",
    label: "ClawRouter",
    defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
    // These are protocol limits, not credential-independent grants or a default model.
    models: [],
    capabilities: PIXVERSE_VIDEO_CAPABILITIES,
    catalogByModel: {
      "pixverse/v6": { modes: ["imageToVideo"] },
      "pixverse/c1": { modes: ["imageToVideo"] },
    },
    async generateVideo(req) {
      const deadline = createProviderOperationDeadline({
        timeoutMs: req.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        label: "ClawRouter PixVerse generation",
      });
      const remaining = createProviderOperationTimeoutResolver({
        deadline,
        defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
      });
      const multipart = preparePixVerseMultipart(req);
      const auth = await resolveApiKeyForProvider({
        provider: "clawrouter",
        cfg: req.cfg,
        agentDir: req.agentDir,
        store: req.authStore,
        modelId: req.model,
        capability: "video",
      });
      if (!auth.apiKey || auth.mode !== "api-key") {
        throw new Error("ClawRouter PixVerse requires the selected ClawRouter API key.");
      }
      const context = resolveClawRouterCapabilityHttpContext(req.cfg, auth.apiKey, "video");
      const offers = await fetchClawRouterCapabilityOffers({
        context,
        timeoutMs: remaining,
        requireFreshProxyCatalog: true,
      });
      const selected = offers.find((offer) => isPixVerseImageOffer(offer, req.model));
      if (!selected) {
        throw new Error(
          "ClawRouter PixVerse image input is unavailable for this key's current catalog.",
        );
      }
      const headers = new Headers(context.headers);
      headers.delete("Content-Length");
      headers.set("Content-Type", multipart.contentType);
      headers.set("Idempotency-Key", multipart.idempotencyKey);
      if (!headers.has("Accept-Encoding")) {
        headers.set("Accept-Encoding", "identity");
      }
      const timeoutMs = remaining();
      // From this invocation onwards, transport failure cannot establish known-unsent.
      // The shared POST helper has no create retry. All later failures are terminal.
      try {
        const owned = await postMultipartRequest({
          url: selected.url,
          headers,
          body: multipart.body,
          timeoutMs,
          fetchFn: fetchWithoutRedirects,
          allowPrivateNetwork: context.allowPrivateNetwork,
          ssrfPolicy: context.ssrfPolicy,
          dispatcherPolicy: context.dispatcherPolicy,
        });
        const created = readPixVerseEnvelope(await readOwnedResponse(owned, remaining, headers));
        const id = readPixVerseId(created.video_id);
        const managedId = owned.response.headers.get("x-clawrouter-managed-job-id");
        if (managedId !== null && readPixVerseId(managedId) !== id) {
          throw new Error("ClawRouter PixVerse managed video identity mismatch.");
        }
        const url =
          selected.url.slice(0, -PIXVERSE_IMAGE_PATH.length) + "/openapi/v2/video/result/" + id;
        const pollHeaders = new Headers(headers);
        pollHeaders.delete("Content-Type");
        pollHeaders.delete("Idempotency-Key");
        const completed = await pollProviderOperation({
          read: async () => {
            const response = await fetchWithTimeoutGuarded(
              url,
              { method: "GET", headers: pollHeaders, redirect: "error" },
              remaining(),
              fetchWithoutRedirects,
              {
                ssrfPolicy: context.ssrfPolicy,
                dispatcherPolicy: context.dispatcherPolicy,
                auditContext: "clawrouter.pixverse-original-video",
              },
            );
            return readPixVerseStatus(
              await readOwnedResponse(response, remaining, pollHeaders),
              id,
            );
          },
          isComplete: (status) => status.complete,
          wait: () => waitProviderOperationPollInterval({ deadline, pollIntervalMs: 5000 }),
          maxAttempts: 180,
          timeoutMessage:
            "ClawRouter PixVerse original video did not complete before its deadline.",
        });
        // Validate before returning: the generic video runner must not discover an invalid
        // post-submission asset outside this terminal boundary and try another provider.
        if (!completed.url) {
          throw new Error("ClawRouter PixVerse completed video is unavailable.");
        }
        remaining();
        return {
          videos: [{ url: completed.url, mimeType: "video/mp4" }],
          model: req.model,
          metadata: { videoId: id, status: 1 },
        };
      } catch (error) {
        throw createMediaGenerationTerminalError(error);
      }
    },
  };
}
