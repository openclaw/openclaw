import {
  buildGoogleMusicGenerationBody,
  parseGoogleMusicGenerationResponse,
  recordModelFallbackStop,
  type MusicGenerationProvider,
  type MusicGenerationRequest,
} from "openclaw/plugin-sdk/music-generation";
import type {
  UnifiedModelCatalogEntry,
  UnifiedModelCatalogProviderContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { resolveApiKeyForProvider } from "openclaw/plugin-sdk/provider-auth-runtime";
import {
  createProviderOperationDeadline,
  createProviderOperationTimeoutResolver,
} from "openclaw/plugin-sdk/provider-http";
import { readResponseWithLimit } from "openclaw/plugin-sdk/response-limit-runtime";
import { fetchWithSsrFGuard, mergeSsrFPolicies } from "openclaw/plugin-sdk/ssrf-runtime";
import {
  asOptionalRecord,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  fetchClawRouterCapabilityOffers,
  resolveClawRouterCapabilityHttpContext,
  type ClawRouterCapabilityOffer,
} from "./capability-offers.js";
import {
  isClawRouterOpenRouterMusicOffer,
  openRouterMusicModels,
  openRouterMusicMode,
  prepareClawRouterOpenRouterMusic,
  readClawRouterOpenRouterMusic,
} from "./music-openrouter.js";

// Finite wire support from ClawRouter's google.music contract, not credential grants.
const MODELS = new Map([
  ["google/lyria-3-clip-preview", "lyria-3-clip-preview"],
  ["google/lyria-3-pro-preview", "lyria-3-pro-preview"],
]);
const PATH = "/v1beta/models/${model}:generateContent";
const JSON_LIMIT = 8 * 1024 * 1024;
const AUDIO_LIMIT = 4 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 180_000;
const googleMode = {
  maxTracks: 1,
  supportsLyrics: true,
  supportsInstrumental: true,
  supportsDuration: false,
  supportsFormat: true,
  supportedFormatsByModel: {
    "google/lyria-3-clip-preview": ["mp3"],
    "google/lyria-3-pro-preview": ["mp3", "wav"],
  },
} satisfies NonNullable<MusicGenerationProvider["capabilities"]["generate"]>;
const googleCapabilities: MusicGenerationProvider["capabilities"] = {
  generate: googleMode,
  edit: { ...googleMode, enabled: true, maxInputImages: 10 },
};
const mode = {
  ...googleMode,
  supportsDurationByModel: Object.fromEntries(
    [...openRouterMusicModels.keys()].map((model) => [model, true]),
  ),
  maxDurationSeconds: 180,
  supportedFormatsByModel: {
    ...googleMode.supportedFormatsByModel,
    "openrouter/google/lyria-3-pro-preview": ["mp3", "wav"],
    "openrouter/google/lyria-3-clip-preview": ["mp3", "wav"],
  },
} satisfies NonNullable<MusicGenerationProvider["capabilities"]["generate"]>;
const capabilities: MusicGenerationProvider["capabilities"] = {
  generate: mode,
  edit: {
    ...mode,
    enabled: true,
    maxInputImages: 10,
    maxInputImagesByModel: Object.fromEntries(
      [...openRouterMusicModels.keys()].map((model) => [model, 0]),
    ),
  },
};

function eligible(offer: ClawRouterCapabilityOffer): boolean {
  if (isClawRouterOpenRouterMusicOffer(offer)) {
    return true;
  }
  const id = normalizeOptionalString(offer.model?.id);
  return (
    id !== undefined &&
    MODELS.has(id) &&
    offer.model?.upstream === MODELS.get(id) &&
    offer.providerId === "google-gemini" &&
    offer.endpoint === "music_generate" &&
    offer.path === PATH &&
    (offer.routeKind === "native" || offer.routeKind === "manifest") &&
    offer.methods.length === 1 &&
    offer.methods[0] === "POST" &&
    offer.requestFormat === "google.music_generate" &&
    offer.responseFormat === "google.music" &&
    Array.isArray(offer.model?.capabilities) &&
    offer.model.capabilities.length === 1 &&
    offer.model.capabilities[0] === "audio.generate"
  );
}

function contextFor(req: Pick<MusicGenerationRequest, "cfg">, apiKey: string) {
  if (req.cfg.models?.providers?.clawrouter?.request?.auth) {
    throw new Error("ClawRouter music requires the selected proxy key without an auth override.");
  }
  const context = resolveClawRouterCapabilityHttpContext(req.cfg, apiKey);
  for (const header of ["x-api-key", "x-goog-api-key", "api-key", "cookie"]) {
    context.headers.delete(header);
  }
  return context;
}

export async function listClawRouterMusicModelCatalog(
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
  });
  const seen = new Set<string>();
  return offers.filter(eligible).flatMap((offer) => {
    const model = String(offer.model!.id);
    if (seen.has(model)) {
      return [];
    }
    seen.add(model);
    return [
      {
        kind: "music_generation" as const,
        provider: "clawrouter",
        model,
        label: normalizeOptionalString(offer.model?.displayName) ?? model,
        source: "live" as const,
        modes: openRouterMusicModels.has(model) ? ["generate"] : ["generate", "edit"],
        capabilities: openRouterMusicModels.has(model)
          ? { generate: openRouterMusicMode }
          : googleCapabilities,
      },
    ];
  });
}

function prepareBody(req: MusicGenerationRequest) {
  if (!MODELS.has(req.model)) {
    throw new Error("Select a qualified ClawRouter Lyria music offer.");
  }
  if (req.durationSeconds !== undefined) {
    throw new Error("Lyria does not accept a duration override.");
  }
  if (
    req.format &&
    !(
      req.format === "mp3" ||
      (req.format === "wav" && MODELS.get(req.model) === "lyria-3-pro-preview")
    )
  ) {
    throw new Error("Unsupported output format for this ClawRouter Lyria offer.");
  }
  if (
    (req.inputImages?.length ?? 0) > 10 ||
    req.inputImages?.some(
      (image) =>
        image.url !== undefined ||
        !image.buffer?.length ||
        !["image/png", "image/jpeg", "image/webp"].includes(image.mimeType ?? ""),
    )
  ) {
    throw new Error("ClawRouter music accepts at most ten inline PNG, JPEG or WebP images.");
  }
  const body = buildGoogleMusicGenerationBody(req);
  const prompt = body.contents[0]!.parts[0]!;
  if (!("text" in prompt) || !prompt.text || prompt.text.length > 65_536) {
    throw new Error("ClawRouter music requires a bounded nonempty prompt.");
  }
  return body;
}

function readMusic(payload: unknown, model: string) {
  const root = asOptionalRecord(payload);
  const candidates = root?.candidates;
  const candidate =
    Array.isArray(candidates) && candidates.length === 1
      ? asOptionalRecord(candidates[0])
      : undefined;
  const parts = asOptionalRecord(candidate?.content)?.parts;
  const blockReason = normalizeOptionalString(asOptionalRecord(root?.promptFeedback)?.blockReason);
  if (
    candidate?.finishReason !== "STOP" ||
    !Array.isArray(parts) ||
    (blockReason !== undefined && !blockReason.endsWith("_UNSPECIFIED"))
  ) {
    throw new Error(
      "ClawRouter music returned an incomplete or ambiguous result; do not replay it.",
    );
  }
  const parsedParts: Array<{ text: string } | { inlineData: { data: string; mimeType: string } }> =
    [];
  let audio = 0;
  for (const value of parts) {
    const part = asOptionalRecord(value);
    const fields = Object.keys(part ?? {}).filter((key) => key !== "thought");
    if (
      !part ||
      (part.thought !== undefined && part.thought !== false) ||
      fields.some((key) => !["text", "inlineData", "inline_data"].includes(key))
    ) {
      throw new Error("ClawRouter music returned an unsupported result part.");
    }
    if (typeof part.text === "string" && fields.length === 1) {
      parsedParts.push({ text: part.text });
      continue;
    }
    const inline = asOptionalRecord(part.inlineData ?? part.inline_data);
    const mimeType = inline?.mimeType ?? inline?.mime_type;
    if (
      fields.length !== 1 ||
      !inline ||
      typeof inline.data !== "string" ||
      !inline.data ||
      inline.data.length > 4 * Math.ceil(AUDIO_LIMIT / 3) ||
      !(
        mimeType === "audio/mpeg" ||
        (mimeType === "audio/wav" && MODELS.get(model) === "lyria-3-pro-preview")
      )
    ) {
      throw new Error("ClawRouter music returned invalid inline audio or MIME type.");
    }
    audio++;
    parsedParts.push({ inlineData: { data: inline.data, mimeType } });
  }
  if (audio !== 1) {
    throw new Error("ClawRouter music requires exactly one final audio track; do not replay it.");
  }
  const result = parseGoogleMusicGenerationResponse({
    response: { candidates: [{ content: { parts: parsedParts } }] },
  });
  const track = result.tracks[0];
  if (result.tracks.length !== 1 || !track?.buffer.length || track.buffer.length > AUDIO_LIMIT) {
    throw new Error("ClawRouter music returned an empty or oversized track.");
  }
  return result;
}

export function buildClawRouterMusicGenerationProvider(): MusicGenerationProvider {
  return {
    id: "clawrouter",
    label: "ClawRouter",
    models: [],
    capabilities,
    async generateMusic(req) {
      req.signal?.throwIfAborted();
      const openRouter = openRouterMusicModels.has(req.model);
      const body = openRouter ? prepareClawRouterOpenRouterMusic(req) : prepareBody(req);
      const timeoutMs = createProviderOperationTimeoutResolver({
        deadline: createProviderOperationDeadline({
          timeoutMs: req.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          label: "ClawRouter music",
        }),
        defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
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
        throw new Error("ClawRouter proxy key missing; upstream credentials are not used.");
      }
      const context = contextFor(req, auth.apiKey);
      const offers = await fetchClawRouterCapabilityOffers({
        context,
        timeoutMs,
        signal: req.signal,
        requireFreshProxyCatalog: true,
      });
      const qualified = offers.filter((offer) => eligible(offer) && offer.model?.id === req.model);
      const selected = qualified.find((offer) => offer.routeKind === "native") ?? qualified[0];
      if (!selected) {
        throw new Error("ClawRouter music offer is absent or unsupported for this proxy key.");
      }
      const wire = JSON.stringify(
        selected.routeKind === "manifest"
          ? { body, ...(openRouter ? {} : { pathParams: { model: selected.model!.upstream } }) }
          : body,
      );
      if (Buffer.byteLength(wire) > (openRouter ? 256 * 1024 : JSON_LIMIT)) {
        throw new Error("ClawRouter music request exceeds its qualified byte limit.");
      }
      const headers = new Headers(context.headers);
      headers.set("Content-Type", "application/json");
      if (openRouter) {
        headers.set("Accept", "text/event-stream");
      }
      req.signal?.throwIfAborted();
      let attempted = false;
      try {
        const { response, release } = await fetchWithSsrFGuard({
          url: selected.url,
          init: { method: "POST", headers, body: wire, signal: req.signal },
          beforeRequest: () => {
            req.signal?.throwIfAborted();
            attempted = true;
          },
          timeoutMs: timeoutMs(),
          maxRedirects: 0,
          policy: mergeSsrFPolicies(
            context.ssrfPolicy,
            context.allowPrivateNetwork ? { allowPrivateNetwork: true } : undefined,
          ),
          dispatcherPolicy: context.dispatcherPolicy,
          auditContext: "clawrouter.music",
        });
        try {
          const encoding = response.headers.get("content-encoding");
          if (
            response.status !== 200 ||
            response.redirected ||
            response.headers.has("content-range") ||
            (encoding !== null && encoding.trim().toLowerCase() !== "identity") ||
            response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !==
              (openRouter ? "text/event-stream" : "application/json")
          ) {
            throw new Error(
              `ClawRouter music returned an invalid HTTP response (${response.status}); do not replay it.`,
            );
          }
          if (openRouter) {
            const result = await readClawRouterOpenRouterMusic(response, req, timeoutMs);
            req.signal?.throwIfAborted();
            return { ...result, model: req.model };
          }
          const bytes = await readResponseWithLimit(response, JSON_LIMIT, {
            timeoutMs,
            signal: req.signal,
          });
          const length = response.headers.get("content-length");
          if (length !== null && (!/^\d+$/u.test(length) || Number(length) !== bytes.length)) {
            throw new Error("ClawRouter music response ended with a mismatched length.");
          }
          let payload: unknown;
          try {
            payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
          } catch {
            // JSON parser diagnostics can otherwise echo response content.
            throw new Error("ClawRouter music returned malformed UTF-8 JSON; do not replay it.");
          }
          const result = readMusic(payload, req.model);
          req.signal?.throwIfAborted();
          return { ...result, model: req.model };
        } finally {
          void response.body?.cancel().catch(() => undefined);
          await release();
        }
      } catch (cause) {
        // This says only that replay is unsafe, not whether the operation was billed/refunded.
        const error =
          cause instanceof Error
            ? cause
            : new Error("ClawRouter music operation failed", { cause });
        if (attempted) {
          recordModelFallbackStop(error);
        }
        throw error;
      }
    },
  };
}
