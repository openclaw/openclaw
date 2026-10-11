import path from "node:path";
import { assertNoWindowsNetworkPath, safeFileURLToPath } from "@openclaw/fs-safe/advanced";
import { MAX_VIDEO_BYTES } from "@openclaw/media-core/constants";
import { normalizeMimeType } from "@openclaw/media-core/mime";
import { asNonArrayRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import type {
  ModelInputContent,
  ProviderContext,
} from "../../../../packages/ai/src/provider-types.js";
import { formatErrorMessage } from "../../../infra/errors.js";
import type { Context, ImageContent, TextContent } from "../../../llm/types.js";
import { redactSensitiveText } from "../../../logging/redact.js";
import {
  attachRuntimePromptMediaFacts,
  isImageMediaFact,
  isVideoMediaFact,
  normalizeMediaFacts,
  readRuntimePromptImageOrder,
  readRuntimePromptMediaFacts,
  readPersistedMediaFacts,
  type MediaFact,
} from "../../../media/media-facts.js";
import { resolveMediaReferenceLocalPath } from "../../../media/media-reference.js";
import type { PromptImageOrderEntry } from "../../../media/prompt-image-order.js";
import { finalizeRuntimePromptImages } from "../../../media/runtime-prompt-image-provenance.js";
import { getMediaDir } from "../../../media/store.js";
import { loadWebMedia, type WebMediaResult } from "../../../media/web-media.js";
import type { UserTurnTranscriptRecorder } from "../../../sessions/user-turn-transcript.types.js";
import { resolveUserPath } from "../../../utils.js";
import type { AgentMessage } from "../../runtime/index.js";
import {
  createSandboxBridgeReadFile,
  resolveSandboxedBridgeMediaPath,
} from "../../sandbox-media-paths.js";
import type { SandboxFsBridge } from "../../sandbox/fs-bridge.js";
import { sanitizeImageBlocks } from "../../tool-images.js";
import { getAgentWorkspaceAccess } from "../../workspace-access.js";
import { log } from "../logger.js";
import {
  mediaFactToImageRef,
  isOpenClawCliImageCachePath,
  resolveMediaFactLocalRef,
  type MediaFileRef,
  type MediaImageRef,
} from "./images.media-refs.js";
import {
  type ImageFactIndex,
  type MediaImageLayout,
  readPersistedImageBlockFactIndexes,
  readPersistedMediaImageLayout,
} from "./prompt-image-metadata.js";

export { hasHydratableMediaImages } from "./images.media-refs.js";

const IMAGE_EXTENSION_PATTERN = "png|jpg|jpeg|gif|webp|bmp|tiff|tif|heic|heif";
const FILE_URL_REGEX_SOURCE = "file://[^\\s<>\"'`\\]]+\\.(?:" + IMAGE_EXTENSION_PATTERN + ")";
const WINDOWS_DRIVE_PATH_REGEX_SOURCE =
  "(?:^|\\s|[\"'`(])([A-Za-z]:[\\\\/][^\\s\"'`()\\[\\]]*\\.(?:" + IMAGE_EXTENSION_PATTERN + "))";
const PATH_REGEX_SOURCE =
  "(?:^|\\s|[\"'`(])((\\.\\.?/|[~/])[^\\s\"'`()\\[\\]]*\\.(?:" + IMAGE_EXTENSION_PATTERN + "))";
const FILE_URL_PATTERN = new RegExp(FILE_URL_REGEX_SOURCE, "gi");
const WINDOWS_DRIVE_PATH_PATTERN = new RegExp(WINDOWS_DRIVE_PATH_REGEX_SOURCE, "gi");
const PATH_PATTERN = new RegExp(PATH_REGEX_SOURCE, "gi");
const LEGACY_ATTACHMENT_MARKER_PATTERN =
  /\[(?:media attached(?:\s+\d+\/\d+)?:|Image:\s*source:)\s*[^\]]+\]/gi;

function normalizeRefForDedupe(raw: string): string {
  const projected =
    process.platform === "darwin" && raw.startsWith("/private/var/")
      ? raw.slice("/private".length)
      : raw;
  return process.platform === "win32" ? normalizeLowercaseStringOrEmpty(projected) : projected;
}

type PromptImageEntry = {
  image: ImageContent;
  factIndex: ImageFactIndex;
};

/** Detects explicit local image paths and file URLs in user prompt text. */
export function detectImageReferences(prompt: string): MediaFileRef[] {
  const refs: MediaFileRef[] = [];
  const seen = new Set<string>();
  const pathPrompt = prompt.replace(LEGACY_ATTACHMENT_MARKER_PATTERN, (marker) =>
    " ".repeat(marker.length),
  );

  const addPathRef = (raw: string, fileUrl: boolean) => {
    const trimmed = raw.trim();
    const dedupeKey = normalizeRefForDedupe(trimmed);
    if (!trimmed || seen.has(dedupeKey)) {
      return;
    }
    // An extension-only basename is a dotfile even though the regex accepts it.
    if (!fileUrl && !path.extname(trimmed)) {
      return;
    }
    let resolved = trimmed;
    try {
      if (fileUrl) {
        resolved = safeFileURLToPath(trimmed);
      } else {
        assertNoWindowsNetworkPath(trimmed, "Image path");
      }
    } catch {
      return;
    }
    if (!fileUrl && trimmed.startsWith("~")) {
      resolved = resolveUserPath(trimmed);
    }
    if (isOpenClawCliImageCachePath(resolved)) {
      return;
    }
    seen.add(dedupeKey);
    refs.push({ raw: trimmed, type: "path", resolved });
  };

  for (const [pattern, group, fileUrl] of [
    [FILE_URL_PATTERN, 0, true],
    [WINDOWS_DRIVE_PATH_PATTERN, 1, false],
    [PATH_PATTERN, 1, false],
  ] as const) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(pathPrompt)) !== null) {
      if (match[group]) {
        addPathRef(match[group], fileUrl);
      }
    }
  }

  return refs;
}

function refDedupeKey(ref: MediaFileRef, workspaceDir?: string): string {
  const resolved =
    ref.type === "path" && workspaceDir && !path.isAbsolute(ref.resolved)
      ? path.resolve(workspaceDir, ref.resolved)
      : ref.resolved;
  return `${ref.type}\0${normalizeRefForDedupe(resolved)}`;
}

function rawAliasDedupeKey(alias: string): string | undefined {
  return path.isAbsolute(alias) ||
    /^[A-Za-z]:[\\/]/.test(alias) ||
    /^[a-z][a-z0-9+.-]*:/i.test(alias)
    ? normalizeRefForDedupe(alias)
    : undefined;
}

async function loadMediaFromRef(
  ref: MediaFileRef & { workspaceDir?: string },
  options: PromptMediaOptions,
  label: string,
  attachment = false,
): Promise<WebMediaResult | null> {
  options.signal?.throwIfAborted();
  // Remote workspaces keep admitted attachment originals on Gateway for hydration.
  // Prompt-discovered workspace references still use the sandbox boundary.
  const gatewayAttachment =
    attachment &&
    Boolean(
      getAgentWorkspaceAccess(
        options.agentWorkspaceDir ?? options.workspaceDir,
        "prepareTurnAttachments",
      )?.prepareTurnAttachments,
    );
  const sandbox = gatewayAttachment ? undefined : options.sandbox;
  const localRoots = gatewayAttachment
    ? [getMediaDir()]
    : (options.localRoots ?? (options.workspaceOnly ? [options.workspaceDir] : undefined));
  const redactedRef = redactSensitiveText(ref.raw || ref.resolved);
  try {
    let targetPath = ref.resolved;

    if (!sandbox) {
      targetPath = await resolveMediaReferenceLocalPath(targetPath);
    }

    if (sandbox) {
      try {
        const resolved = await resolveSandboxedBridgeMediaPath({
          sandbox: {
            ...sandbox,
            workspaceOnly: options.workspaceOnly,
          },
          mediaPath: targetPath,
          inboundFallbackDir: "media/inbound",
        });
        targetPath = resolved.resolved;
      } catch (err) {
        log.warn(
          `${label}: sandbox validation failed for ${redactedRef}: ${redactSensitiveText(formatErrorMessage(err))}`,
        );
        return null;
      }
    } else if (!path.isAbsolute(targetPath)) {
      targetPath = path.resolve(ref.workspaceDir ?? options.workspaceDir, targetPath);
    }

    const media = sandbox
      ? await loadWebMedia(targetPath, {
          maxBytes: options.maxBytes,
          sandboxValidated: true,
          readFile: createSandboxBridgeReadFile({ sandbox }),
        })
      : await loadWebMedia(
          targetPath,
          localRoots ? { maxBytes: options.maxBytes, localRoots } : options.maxBytes,
        );

    options.signal?.throwIfAborted();
    return media;
  } catch (err) {
    options.signal?.throwIfAborted();
    log.warn(
      `${label}: failed to load ${redactedRef}: ${redactSensitiveText(formatErrorMessage(err))}`,
    );
    return null;
  }
}

export async function detectAndLoadPromptImages(
  params: Omit<PromptMediaOptions, "provider" | "signal" | "onCurrentTurnImageFailure"> & {
    prompt: string;
    userTurnTranscriptRecorder?: Pick<UserTurnTranscriptRecorder, "resolveMessage">;
    media?: readonly MediaFact[];
    existingImages?: ImageContent[];
    existingImageFactIndexes?: readonly ImageFactIndex[];
    imageOrder?: PromptImageOrderEntry[];
    mediaImageLayout?: MediaImageLayout;
  },
): Promise<{
  images: ImageContent[];
  imageFactIndexes: ImageFactIndex[];
  detectedRefs: MediaFileRef[];
  failedMediaCount: number;
  loadedCount: number;
  skippedCount: number;
}> {
  const counts = { failedMediaCount: 0, loadedCount: 0, skippedCount: 0 };
  if (!params.model.input?.includes("image")) {
    return {
      images: [],
      imageFactIndexes: [],
      detectedRefs: [],
      ...counts,
    };
  }
  // Deferred transcript preparation can carry fresher facts than the recorder's
  // initial message. Resolve without persisting before choosing image ownership.
  const message = await params.userTurnTranscriptRecorder?.resolveMessage();
  const media = normalizeMediaFacts(
    (message ? readPersistedMediaFacts(message) : undefined) ?? params.media,
  );
  const mediaImageLayout =
    (message ? readPersistedMediaImageLayout(message) : undefined) ?? params.mediaImageLayout;
  const suppressed = new Set([
    ...(mediaImageLayout?.suppressedFactIndexes ?? []),
    ...media.flatMap((fact, index) => (fact.hydrationSuppressed === true ? [index] : [])),
  ]);
  const imageFactIndexes = media.flatMap((fact, factIndex) =>
    isImageMediaFact(fact) && !suppressed.has(factIndex) ? [factIndex] : [],
  );
  const refs = media.map(mediaFactToImageRef).filter((ref): ref is MediaImageRef => Boolean(ref));
  const refsByFact = new Map(refs.map((ref) => [ref.factIndex, ref]));
  const inferredSlots = (() => {
    if (params.imageOrder?.length === imageFactIndexes.length) {
      return params.imageOrder.map((kind, index) => ({
        kind,
        factIndex: imageFactIndexes[index],
      }));
    }
    if (params.imageOrder?.length) {
      const pending = [...imageFactIndexes];
      return [
        ...params.imageOrder.map((kind) => ({
          kind,
          ...(kind === "offloaded" && pending.length ? { factIndex: pending.shift() } : {}),
        })),
        ...pending.map((factIndex) => ({ kind: "offloaded" as const, factIndex })),
      ];
    }
    return imageFactIndexes.map((factIndex, imageIndex) => ({
      factIndex,
      kind:
        !media[factIndex]?.path &&
        !media[factIndex]?.url &&
        imageIndex < (params.existingImages?.length ?? 0)
          ? ("inline" as const)
          : ("offloaded" as const),
    }));
  })();
  const slots = mediaImageLayout?.slots.length
    ? mediaImageLayout.slots.filter(
        (slot) => slot.factIndex === undefined || !suppressed.has(slot.factIndex),
      )
    : inferredSlots;
  const layoutInlineIndexes = (mediaImageLayout?.slots ?? slots).flatMap((slot) =>
    slot.kind === "inline" ? [slot.factIndex ?? null] : [],
  );
  const existingIndexes =
    (message ? readPersistedImageBlockFactIndexes(message) : undefined) ??
    params.existingImageFactIndexes ??
    (layoutInlineIndexes.length === (params.existingImages?.length ?? 0)
      ? layoutInlineIndexes
      : params.existingImages?.map(() => null));
  const unusedExisting = (params.existingImages ?? [])
    .map((image, index) => ({
      image,
      factIndex: existingIndexes?.[index] ?? null,
    }))
    .filter((entry) => entry.factIndex === null || !suppressed.has(entry.factIndex));
  const takeExisting = (
    factIndex: number | undefined,
    allowUnowned: boolean,
  ): PromptImageEntry | undefined => {
    const exact = unusedExisting.findIndex((entry) => entry.factIndex === factIndex);
    const index =
      exact >= 0
        ? exact
        : allowUnowned
          ? unusedExisting.findIndex((entry) => entry.factIndex === null)
          : -1;
    return index >= 0 ? unusedExisting.splice(index, 1)[0] : undefined;
  };
  const attachmentRefs = slots.flatMap((slot) =>
    slot.kind === "offloaded" && slot.factIndex !== undefined
      ? (refsByFact.get(slot.factIndex) ?? [])
      : [],
  );
  const attachmentKeys = new Set(
    attachmentRefs.map((ref) => refDedupeKey(ref, ref.workspaceDir ?? params.workspaceDir)),
  );
  const attachmentRawKeys = new Set(
    attachmentRefs.flatMap((ref) => ref.aliases.flatMap((alias) => rawAliasDedupeKey(alias) ?? [])),
  );
  const promptRefs = detectImageReferences(params.prompt).filter(
    (ref) =>
      !attachmentRawKeys.has(rawAliasDedupeKey(ref.raw) ?? "") &&
      !attachmentKeys.has(refDedupeKey(ref, params.workspaceDir)),
  );
  const detectedRefs = [
    ...refs.flatMap(({ detect, hydrate, raw, type, resolved }) =>
      detect !== false &&
      (hydrate || (!resolved.startsWith("http://") && !resolved.startsWith("https://")))
        ? [{ raw, type, resolved }]
        : [],
    ),
    ...promptRefs,
  ];
  const loadRef = async (ref: MediaFileRef & { workspaceDir?: string }, attachment = false) => {
    const loadedMedia = await loadMediaFromRef(
      ref,
      { ...params, signal: undefined },
      "Native image",
      attachment,
    );
    if (!loadedMedia || loadedMedia.kind !== "image") {
      counts.skippedCount++;
      return null;
    }
    const image: ImageContent = {
      type: "image",
      data: loadedMedia.buffer.toString("base64"),
      mimeType: loadedMedia.contentType ?? "image/jpeg",
    };
    counts.loadedCount++;
    log.debug(`Native image: loaded ${ref.type} ${ref.resolved}`);
    return image;
  };
  const promptImages: PromptImageEntry[] = [];
  for (const slot of slots) {
    const existing = takeExisting(slot.factIndex, slot.kind === "inline");
    if (existing) {
      promptImages.push(existing);
      continue;
    }
    // Gateway-owned transcripts retain managed facts, not necessarily inline bytes.
    // A missing inline block must hydrate its exact fact on replay, just like an offloaded slot.
    const ref = slot.factIndex === undefined ? undefined : refsByFact.get(slot.factIndex);
    const image = ref?.hydrate ? await loadRef(ref, true) : null;
    if ((ref?.hydrate || slot.kind === "inline") && !image) {
      counts.failedMediaCount++;
    }
    if (image) {
      promptImages.push({ image, factIndex: ref?.factIndex ?? null });
    }
  }
  promptImages.push(...unusedExisting);
  for (const ref of promptRefs) {
    const image = await loadRef(ref);
    if (image) {
      promptImages.push({ image, factIndex: null });
    }
  }
  const imageSanitization = {
    maxBytes: params.maxBytes,
    maxDimensionPx: params.maxDimensionPx,
    verifyDecodability: true,
  };
  const sanitized: PromptImageEntry[] = [];
  let dropped = 0;
  for (const entry of promptImages) {
    const result = await sanitizeImageBlocks([entry.image], "prompt:images", imageSanitization);
    const image = result.images[0];
    if (image) {
      sanitized.push({ image, factIndex: entry.factIndex });
    }
    dropped += result.dropped;
    if (result.dropped > 0 && entry.factIndex !== null) {
      counts.failedMediaCount++;
    }
  }
  if (dropped > 0) {
    log.warn(`Native image: dropped ${dropped} image(s) after sanitization (prompt:images).`);
  }

  return {
    ...finalizeRuntimePromptImages(sanitized),
    detectedRefs,
    ...counts,
  };
}

type PromptMediaOptions = {
  workspaceDir: string;
  /** Registered agent workspace, when sandbox execution uses a different directory. */
  agentWorkspaceDir?: string;
  model: { input?: string[] };
  maxBytes?: number;
  maxDimensionPx?: number;
  workspaceOnly?: boolean;
  localRoots?: readonly string[];
  sandbox?: { root: string; bridge: SandboxFsBridge };
  provider?: boolean;
  signal?: AbortSignal;
  onCurrentTurnImageFailure?: (count: number) => void;
};

export function buildPromptImageFailureNotice(count: number): string {
  return `System note: ${count} image attachment${count === 1 ? "" : "s"} could not be loaded; their image contents are unavailable. Tell the user and ask them to resend ${count === 1 ? "the image" : "the images"}; do not claim inspection.`;
}

const VIDEO_OMISSION = {
  unsupported: "(video omitted: provider does not support native video)",
  unavailable: "(video omitted: source unavailable)",
  invalid: "(video omitted: invalid video MIME type)",
  limit: "(video omitted: native video byte limit exceeded)",
} as const;

async function materializeVideoFact(
  fact: MediaFact,
  budget: { remaining: number },
  options: PromptMediaOptions,
): Promise<ModelInputContent> {
  if ((fact.sizeBytes ?? 0) > budget.remaining) {
    return { type: "text", text: VIDEO_OMISSION.limit };
  }
  const ref = resolveMediaFactLocalRef(fact);
  const loaded = ref
    ? await loadMediaFromRef(
        { ...ref, workspaceDir: fact.workspaceDir },
        { ...options, maxBytes: budget.remaining },
        "Native video",
        true,
      )
    : null;
  if (!loaded) {
    return { type: "text", text: VIDEO_OMISSION.unavailable };
  }
  const mimeType = normalizeMimeType(loaded.contentType);
  if (loaded.kind !== "video" || !mimeType?.startsWith("video/")) {
    return { type: "text", text: VIDEO_OMISSION.invalid };
  }
  if (loaded.buffer.length > budget.remaining) {
    return { type: "text", text: VIDEO_OMISSION.limit };
  }
  budget.remaining -= loaded.buffer.length;
  return { type: "video", data: loaded.buffer.toString("base64"), mimeType };
}

async function projectOrderedPromptMedia(params: {
  content: Array<TextContent | ImageContent>;
  media: MediaFact[];
  images: ImageContent[];
  imageFactIndexes: ImageFactIndex[];
  options: PromptMediaOptions;
  budget: { remaining: number };
}): Promise<ModelInputContent[]> {
  const generatedMarkers = new Set<string>(Object.values(VIDEO_OMISSION));
  const projected: ModelInputContent[] = params.content.filter(
    (block): block is TextContent => block.type === "text" && !generatedMarkers.has(block.text),
  );
  // Hydration already resolved image order, including inline blocks with no managed fact.
  if (!params.media.some(isVideoMediaFact)) {
    return [...projected, ...params.images];
  }
  const imagesByFact = new Map<number, ImageContent[]>();
  const factlessImages: ImageContent[] = [];
  params.images.forEach((image, index) => {
    const factIndex = params.imageFactIndexes[index];
    if (factIndex == null) {
      factlessImages.push(image);
    } else {
      imagesByFact.set(factIndex, [...(imagesByFact.get(factIndex) ?? []), image]);
    }
  });
  for (const [factIndex, fact] of params.media.entries()) {
    if (isImageMediaFact(fact)) {
      projected.push(...(imagesByFact.get(factIndex) ?? []));
    } else if (isVideoMediaFact(fact)) {
      projected.push(
        params.options.provider
          ? await materializeVideoFact(fact, params.budget, params.options)
          : { type: "text", text: VIDEO_OMISSION.unsupported },
      );
    }
  }
  projected.push(...factlessImages);
  return projected;
}

/** Hydrates exact-message media facts for canonical replay or one provider call. */
async function materializePromptMediaMessages(
  messages: AgentMessage[],
  options: PromptMediaOptions,
): Promise<AgentMessage[]> {
  let hydrated: AgentMessage[] | undefined;
  const videoBudget = { remaining: MAX_VIDEO_BYTES };
  const activeUserIndex = messages.findLastIndex((message) => message.role === "user");
  for (const [index, message] of messages.entries()) {
    if (message.role !== "user") {
      continue;
    }
    const runtimeMedia = readRuntimePromptMediaFacts(message);
    const meta = Reflect.get(message, "__openclaw");
    const resolvedMedia = runtimeMedia ?? readPersistedMediaFacts(message) ?? [];
    const runtimeImageOrder = readRuntimePromptImageOrder(message);
    const mediaImageLayout = readPersistedMediaImageLayout(message);
    if (!resolvedMedia.length) {
      continue;
    }
    const content = Array.isArray(message.content)
      ? message.content
      : [{ type: "text" as const, text: message.content }];
    const existingImages = content.filter((block): block is ImageContent => block.type === "image");
    const result = await detectAndLoadPromptImages({
      ...options,
      prompt: "",
      media: resolvedMedia,
      existingImages,
      existingImageFactIndexes: readPersistedImageBlockFactIndexes(message),
      mediaImageLayout,
    });
    const projectedContent = await projectOrderedPromptMedia({
      content,
      media: resolvedMedia,
      images: result.images,
      imageFactIndexes: result.imageFactIndexes,
      options,
      budget: videoBudget,
    });
    if (
      (options.provider || options.onCurrentTurnImageFailure) &&
      index === activeUserIndex &&
      result.failedMediaCount > 0
    ) {
      options.onCurrentTurnImageFailure?.(result.failedMediaCount);
      projectedContent.push({
        type: "text",
        text: buildPromptImageFailureNotice(result.failedMediaCount),
      });
    }
    hydrated ??= messages.slice();
    if (options.provider) {
      hydrated[index] = {
        role: "user",
        content: projectedContent,
        timestamp: message.timestamp,
        ...(message.runtimeContextCarrier ? { runtimeContextCarrier: true } : {}),
        ...(message.runtimeContextCarrierRetained !== undefined
          ? { runtimeContextCarrierRetained: message.runtimeContextCarrierRetained }
          : {}),
      } as ProviderContext["messages"][number] as AgentMessage;
      continue;
    }
    const nextMeta = { ...asNonArrayRecord(meta) };
    if (result.images.length > 0) {
      nextMeta.mediaImageBlockFactIndexes = result.imageFactIndexes;
    } else {
      delete nextMeta.mediaImageBlockFactIndexes;
    }
    const hydratedMessage = {
      ...message,
      content: projectedContent,
    } as AgentMessage;
    if (Object.keys(nextMeta).length > 0) {
      Reflect.set(hydratedMessage, "__openclaw", nextMeta);
    } else {
      Reflect.deleteProperty(hydratedMessage, "__openclaw");
    }
    if (runtimeMedia) {
      attachRuntimePromptMediaFacts(hydratedMessage, runtimeMedia, runtimeImageOrder);
    }
    hydrated[index] = hydratedMessage;
  }
  return hydrated ?? messages;
}

/** Hydrates non-enumerable facts carried by queued user turns before canonical replay. */
export async function hydratePromptMediaMessages(
  messages: AgentMessage[],
  options: Omit<PromptMediaOptions, "provider">,
): Promise<AgentMessage[]> {
  return await materializePromptMediaMessages(messages, options);
}

/** Materializes one transient provider context from exact-message media facts. */
export async function materializeProviderContext(
  params: Omit<PromptMediaOptions, "provider" | "model" | "maxBytes" | "maxDimensionPx"> & {
    context: Context;
  },
): Promise<ProviderContext> {
  const messages = await materializePromptMediaMessages(params.context.messages as AgentMessage[], {
    ...params,
    model: { input: ["text", "image"] },
    provider: true,
  });
  params.signal?.throwIfAborted();
  return messages === params.context.messages
    ? (params.context as ProviderContext)
    : ({ ...params.context, messages } as ProviderContext);
}
