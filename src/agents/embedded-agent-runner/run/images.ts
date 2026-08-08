import path from "node:path";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { formatErrorMessage } from "../../../infra/errors.js";
import { assertNoWindowsNetworkPath, safeFileURLToPath } from "../../../infra/local-file-access.js";
import type { ImageContent, MediaContent } from "../../../llm/types.js";
import {
  attachRuntimePromptMediaFacts,
  isImageMediaFact,
  normalizeMediaFacts,
  readRuntimePromptImageOrder,
  readRuntimePromptMediaFacts,
  readPersistedMediaFacts,
} from "../../../media/media-facts.js";
import {
  resolveInboundMediaReference,
  resolveMediaReferenceLocalPath,
} from "../../../media/media-reference.js";
import type { PromptImageOrderEntry } from "../../../media/prompt-image-order.js";
import { finalizeRuntimePromptImages } from "../../../media/runtime-prompt-image-provenance.js";
import { loadWebMedia } from "../../../media/web-media.js";
import { resolveUserPath } from "../../../utils.js";
import type { ImageSanitizationLimits } from "../../image-sanitization.js";
import type { AgentMessage } from "../../runtime/index.js";
import {
  createSandboxBridgeReadFile,
  resolveSandboxedBridgeMediaPath,
} from "../../sandbox-media-paths.js";
import type { SandboxFsBridge } from "../../sandbox/fs-bridge.js";
import { sanitizeImageBlocks } from "../../tool-images.js";
import { log } from "../logger.js";
import {
  collectIdentitylessMediaImageFactIndexes,
  collectMediaImageRefs,
  isOpenClawCliImageCachePath,
  selectMediaImageRefs,
  type MediaImageRef,
} from "./images.media-refs.js";
import {
  type ImageFactIndex,
  type MediaImageLayout,
  countMissingLayoutInlineSlots,
  readPersistedImageBlockFactIndexes,
  readPersistedMediaImageLayout,
  resolveLayoutInlineFactIndexes,
} from "./prompt-image-metadata.js";
import {
  hydrateNativePromptMedia,
  resolveOmittedPromptVideoBlocks,
  type DetectedPromptMediaRef,
  type PromptImageLoadParams,
  type PromptImageLoadResult,
  type PromptMediaLoadParams,
  type PromptMediaLoadResult,
  type PromptMediaReadOptions,
} from "./prompt-media.js";

export { hasHydratableMediaImages } from "./images.media-refs.js";

const IMAGE_EXTENSION_NAMES = [
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "bmp",
  "tiff",
  "tif",
  "heic",
  "heif",
] as const;
const IMAGE_EXTENSIONS = new Set<string>();
for (const ext of IMAGE_EXTENSION_NAMES) {
  IMAGE_EXTENSIONS.add(`.${ext}`);
}
const IMAGE_EXTENSION_PATTERN = IMAGE_EXTENSION_NAMES.join("|");
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

type DetectedImageRef = DetectedPromptMediaRef;

function isImageExtension(filePath: string): boolean {
  const ext = normalizeLowercaseStringOrEmpty(path.extname(filePath));
  return IMAGE_EXTENSIONS.has(ext);
}

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

function mergePromptAttachmentImages(params: {
  imageOrder?: PromptImageOrderEntry[];
  mediaImageLayout?: MediaImageLayout;
  existingImages?: ImageContent[];
  existingImageFactIndexes?: readonly ImageFactIndex[];
  offloadedImages?: Array<PromptImageEntry | null>;
  promptRefImages?: ImageContent[];
}): PromptImageEntry[] {
  const existingImages = (params.existingImages ?? []).map((image, index) => ({
    image,
    factIndex: params.existingImageFactIndexes?.[index] ?? null,
  }));
  const offloadedImages = params.offloadedImages ?? [];
  const promptRefImages = (params.promptRefImages ?? []).map((image) => ({
    image,
    factIndex: null,
  }));
  const slots: MediaImageLayout["slots"] =
    params.mediaImageLayout?.slots ?? params.imageOrder?.map((kind) => ({ kind })) ?? [];
  if (slots.length === 0) {
    const factOwned = [...offloadedImages, ...existingImages]
      .filter((entry): entry is PromptImageEntry => entry !== null && entry.factIndex !== null)
      .toSorted((left, right) => (left.factIndex ?? 0) - (right.factIndex ?? 0));
    return [
      ...factOwned,
      ...existingImages.filter((entry) => entry.factIndex === null),
      ...promptRefImages,
    ];
  }

  const unusedExisting = [...existingImages];
  const takeExisting = (factIndex: number | null | undefined): PromptImageEntry | undefined => {
    const matchIndex =
      factIndex === undefined
        ? 0
        : unusedExisting.findIndex((entry) => entry.factIndex === factIndex);
    if (matchIndex < 0) {
      return undefined;
    }
    return unusedExisting.splice(matchIndex, 1)[0];
  };
  let offloadedIndex = 0;
  const ordered = slots.flatMap((slot) => {
    const offloaded = slot.kind === "offloaded" ? offloadedImages[offloadedIndex++] : undefined;
    const exactExisting =
      slot.factIndex !== undefined
        ? takeExisting(slot.factIndex)
        : slot.kind === "inline"
          ? takeExisting(undefined)
          : undefined;
    const existing =
      exactExisting ??
      (slot.kind === "inline" && slot.factIndex !== undefined ? takeExisting(null) : undefined);
    if (existing) {
      return [existing];
    }
    if (slot.kind === "inline") {
      return [];
    }
    return offloaded ? [offloaded] : [];
  });
  return [
    ...ordered,
    ...unusedExisting,
    ...offloadedImages
      .slice(offloadedIndex)
      .filter((entry): entry is PromptImageEntry => entry !== null),
    ...promptRefImages,
  ];
}

async function sanitizeImageEntriesWithLog(
  entries: PromptImageEntry[],
  label: string,
  imageSanitization?: ImageSanitizationLimits,
): Promise<{ entries: PromptImageEntry[]; failedMediaCount: number }> {
  const sanitized: PromptImageEntry[] = [];
  let dropped = 0;
  let failedMediaCount = 0;
  for (const entry of entries) {
    const result = await sanitizeImageBlocks([entry.image], label, imageSanitization);
    const image = result.images[0];
    if (image) {
      sanitized.push({ image, factIndex: entry.factIndex });
    }
    dropped += result.dropped;
    if (result.dropped > 0 && entry.factIndex !== null) {
      failedMediaCount++;
    }
  }
  if (dropped > 0) {
    log.warn(`Native image: dropped ${dropped} image(s) after sanitization (${label}).`);
  }
  return { entries: sanitized, failedMediaCount };
}

/** Detects explicit local image paths and file URLs in user prompt text. */
export function detectImageReferences(prompt: string): DetectedImageRef[] {
  const refs: DetectedImageRef[] = [];
  const seen = new Set<string>();
  const pathPrompt = prompt.replace(LEGACY_ATTACHMENT_MARKER_PATTERN, (marker) =>
    " ".repeat(marker.length),
  );

  const addPathRef = (raw: string) => {
    const trimmed = raw.trim();
    const dedupeKey = normalizeRefForDedupe(trimmed);
    if (!trimmed || seen.has(dedupeKey)) {
      return;
    }
    if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
      return;
    }
    if (!isImageExtension(trimmed)) {
      return;
    }
    try {
      assertNoWindowsNetworkPath(trimmed, "Image path");
    } catch {
      return;
    }
    const resolved = trimmed.startsWith("~") ? resolveUserPath(trimmed) : trimmed;
    if (isOpenClawCliImageCachePath(resolved)) {
      return;
    }
    seen.add(dedupeKey);
    refs.push({ raw: trimmed, type: "path", resolved });
  };

  FILE_URL_PATTERN.lastIndex = 0;
  WINDOWS_DRIVE_PATH_PATTERN.lastIndex = 0;
  PATH_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = FILE_URL_PATTERN.exec(pathPrompt)) !== null) {
    const raw = match[0];
    const dedupeKey = normalizeRefForDedupe(raw);
    if (seen.has(dedupeKey)) {
      continue;
    }
    try {
      const resolved = safeFileURLToPath(raw);
      if (isOpenClawCliImageCachePath(resolved)) {
        continue;
      }
      seen.add(dedupeKey);
      refs.push({ raw, type: "path", resolved });
    } catch {
      continue;
    }
  }

  while ((match = WINDOWS_DRIVE_PATH_PATTERN.exec(pathPrompt)) !== null) {
    if (match[1]) {
      addPathRef(match[1]);
    }
  }

  while ((match = PATH_PATTERN.exec(pathPrompt)) !== null) {
    if (match[1]) {
      addPathRef(match[1]);
    }
  }

  return refs;
}

function refDedupeKey(ref: DetectedImageRef, workspaceDir?: string): string {
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

async function loadPromptMediaFromRef(
  ref: DetectedImageRef,
  workspaceDir: string,
  options: PromptMediaReadOptions,
): Promise<MediaContent | null> {
  try {
    let targetPath = ref.resolved;
    let managedInboundHostRead = false;

    if (!options.sandbox) {
      targetPath = await resolveMediaReferenceLocalPath(targetPath);
    }

    if (options.sandbox) {
      try {
        const resolved = await resolveSandboxedBridgeMediaPath({
          sandbox: {
            root: options.sandbox.root,
            bridge: options.sandbox.bridge,
            workspaceOnly: options.workspaceOnly,
          },
          mediaPath: targetPath,
          inboundFallbackDir: "media/inbound",
        });
        targetPath = resolved.resolved;
      } catch (err) {
        // Gateway-owned inbound video is intentionally never staged: the sandbox's
        // tool-file limit is smaller than the model's native-video contract.
        const inbound =
          options.kind === "video"
            ? await resolveInboundMediaReference(targetPath).catch(() => undefined)
            : undefined;
        if (!inbound) {
          log.debug(
            `Native ${options.kind}: sandbox validation failed for ${ref.resolved}: ${formatErrorMessage(err)}`,
          );
          return null;
        }
        targetPath = inbound.physicalPath;
        managedInboundHostRead = true;
      }
    } else if (!path.isAbsolute(targetPath)) {
      targetPath = path.resolve(workspaceDir, targetPath);
    }

    const media =
      options.sandbox && !managedInboundHostRead
        ? await loadWebMedia(targetPath, {
            maxBytes: options.maxBytes,
            sandboxValidated: true,
            readFile: createSandboxBridgeReadFile({ sandbox: options.sandbox }),
          })
        : await loadWebMedia(
            targetPath,
            options.workspaceOnly || options.localRoots || managedInboundHostRead
              ? {
                  maxBytes: options.maxBytes,
                  localRoots: managedInboundHostRead
                    ? [...(options.localRoots ?? [workspaceDir]), path.dirname(targetPath)]
                    : (options.localRoots ?? [workspaceDir]),
                }
              : options.maxBytes,
          );

    if (media.kind !== options.kind) {
      log.debug(`Native ${options.kind}: unexpected media kind: ${targetPath} (got ${media.kind})`);
      return null;
    }

    const mimeType = media.contentType ?? (options.kind === "image" ? "image/jpeg" : "video/mp4");
    const data = media.buffer.toString("base64");

    return options.kind === "image"
      ? { type: "image", data, mimeType }
      : { type: "video", data, mimeType };
  } catch (err) {
    log.debug(`Native ${options.kind}: failed to load ${ref.resolved}: ${formatErrorMessage(err)}`);
    return null;
  }
}

function modelSupportsImages(model: { input?: string[] }): boolean {
  return model.input?.includes("image") ?? false;
}

export async function detectAndLoadPromptImages(
  params: PromptImageLoadParams,
): Promise<PromptImageLoadResult> {
  if (!modelSupportsImages(params.model)) {
    return {
      images: [],
      imageFactIndexes: [],
      detectedRefs: [],
      failedMediaCount: 0,
      loadedCount: 0,
      skippedCount: 0,
    };
  }

  const allMediaRefs = collectMediaImageRefs(params.media);
  const suppressedFactIndexes = new Set(params.mediaImageLayout?.suppressedFactIndexes ?? []);
  for (const ref of allMediaRefs) {
    if (!ref || !suppressedFactIndexes.has(ref.factIndex)) {
      continue;
    }
    ref.hydrate = false;
  }
  const orderRefs = allMediaRefs.filter(
    (ref) => !ref || (!suppressedFactIndexes.has(ref.factIndex) && ref.hydrate),
  );
  const imageOrder = params.mediaImageLayout?.slots.map((slot) => slot.kind) ?? params.imageOrder;
  const refsByFactIndex = new Map(
    allMediaRefs.flatMap((ref) => (ref ? [[ref.factIndex, ref] as const] : [])),
  );
  // imageOrder describes only images still requiring native delivery; described
  // (suppressed) facts must not count against it, or the inference silently
  // skips and inline sanitization failures dispatch as success.
  const unsuppressedImageFactIndexes = normalizeMediaFacts(params.media).flatMap(
    (fact, factIndex) =>
      isImageMediaFact(fact) &&
      fact.hydrationSuppressed !== true &&
      !suppressedFactIndexes.has(factIndex)
        ? [factIndex]
        : [],
  );
  const inferredExistingImageFactIndexes =
    imageOrder && unsuppressedImageFactIndexes.length === imageOrder.length
      ? imageOrder.flatMap((entry, index) =>
          entry === "inline" ? [unsuppressedImageFactIndexes[index] ?? null] : [],
        )
      : undefined;
  const inferredMediaImageLayout =
    !params.mediaImageLayout &&
    imageOrder &&
    unsuppressedImageFactIndexes.length === imageOrder.length
      ? {
          slots: imageOrder.map((kind, index) => ({
            kind,
            factIndex: unsuppressedImageFactIndexes[index],
          })),
          suppressedFactIndexes: [],
        }
      : undefined;
  const layoutInlineFactIndexes = resolveLayoutInlineFactIndexes(
    params.mediaImageLayout,
    params.existingImages?.length ?? 0,
  );
  const existingImageFactIndexes =
    params.existingImageFactIndexes ??
    layoutInlineFactIndexes ??
    (inferredExistingImageFactIndexes?.length === (params.existingImages?.length ?? 0)
      ? inferredExistingImageFactIndexes
      : undefined);
  const missingInlineMediaCount = countMissingLayoutInlineSlots(
    params.mediaImageLayout,
    existingImageFactIndexes,
    params.existingImages?.length ?? 0,
  );
  const attachmentRefs = params.mediaImageLayout
    ? params.mediaImageLayout.slots.flatMap((slot) =>
        slot.kind === "offloaded"
          ? [
              {
                factIndex: slot.factIndex,
                ref: slot.factIndex === undefined ? undefined : refsByFactIndex.get(slot.factIndex),
              },
            ]
          : [],
      )
    : selectMediaImageRefs({
        refs: orderRefs,
        existingImageCount: params.existingImages?.length ?? 0,
        imageOrder,
      }).map((ref) => ({ factIndex: ref?.factIndex, ref }));
  const materializedFactIndexes = new Set(
    (existingImageFactIndexes ?? []).filter((entry): entry is number => typeof entry === "number"),
  );
  const availableMediaRefs = allMediaRefs.filter((ref): ref is MediaImageRef => ref !== undefined);
  const selectedAttachmentRefs = attachmentRefs.flatMap(({ ref }) => (ref ? [ref] : []));
  const attachmentKeys = new Set(
    selectedAttachmentRefs.map((ref) => refDedupeKey(ref, ref.workspaceDir ?? params.workspaceDir)),
  );
  const attachmentRawKeys = new Set(
    selectedAttachmentRefs.flatMap((ref) =>
      ref.aliases.flatMap((alias) => {
        const key = rawAliasDedupeKey(alias);
        return key ? [key] : [];
      }),
    ),
  );
  const promptRefs = detectImageReferences(params.prompt).filter(
    (ref) =>
      !attachmentRawKeys.has(rawAliasDedupeKey(ref.raw) ?? "") &&
      !attachmentKeys.has(refDedupeKey(ref, params.workspaceDir)),
  );
  const detectedRefs = [
    ...availableMediaRefs.flatMap(({ detect, hydrate, raw, type, resolved }) =>
      detect !== false &&
      (hydrate || (!resolved.startsWith("http://") && !resolved.startsWith("https://")))
        ? [{ raw, type, resolved }]
        : [],
    ),
    ...promptRefs,
  ];
  if (attachmentRefs.length === 0 && promptRefs.length === 0) {
    const existingImages = params.existingImages ?? [];
    const sanitized = existingImages.length
      ? await sanitizeImageEntriesWithLog(
          existingImages.map((image, index) => ({
            image,
            factIndex: existingImageFactIndexes?.[index] ?? null,
          })),
          "prompt:images",
          {
            maxBytes: params.maxBytes,
            maxDimensionPx: params.maxDimensionPx,
          },
        )
      : { entries: [], failedMediaCount: 0 };
    const finalized = finalizeRuntimePromptImages(sanitized.entries);
    return {
      ...finalized,
      detectedRefs,
      failedMediaCount: missingInlineMediaCount + sanitized.failedMediaCount,
      loadedCount: 0,
      skippedCount: 0,
    };
  }

  log.debug(
    `Native image: prepared ${attachmentRefs.length} attachment ref(s) and ${promptRefs.length} explicit prompt ref(s)`,
  );
  let loadedCount = 0;
  let failedMediaCount = missingInlineMediaCount;
  let skippedCount = 0;
  const loadRef = async (
    ref: DetectedImageRef & { workspaceDir?: string },
  ): Promise<ImageContent | null> => {
    const loaded = await loadPromptMediaFromRef(ref, ref.workspaceDir ?? params.workspaceDir, {
      kind: "image",
      maxBytes: params.maxBytes,
      workspaceOnly: params.workspaceOnly,
      localRoots: params.localRoots ?? (params.workspaceOnly ? [params.workspaceDir] : undefined),
      sandbox: params.sandbox,
    });
    const image = loaded?.type === "image" ? loaded : null;
    if (image) {
      loadedCount++;
      log.debug(`Native image: loaded ${ref.type} ${ref.resolved}`);
    } else {
      skippedCount++;
    }
    return image;
  };
  const offloadedImages: Array<PromptImageEntry | null> = [];
  for (const attachment of attachmentRefs) {
    const factIndex = attachment.factIndex;
    if (factIndex !== undefined && materializedFactIndexes.has(factIndex)) {
      offloadedImages.push(null);
      continue;
    }
    const ref = attachment.ref;
    if (!ref) {
      failedMediaCount++;
      offloadedImages.push(null);
      continue;
    }
    const image = ref.hydrate ? await loadRef(ref) : null;
    if (ref.hydrate && !image) {
      failedMediaCount++;
    }
    offloadedImages.push(image ? { image, factIndex: ref.factIndex } : null);
  }
  const promptRefImages: ImageContent[] = [];
  for (const ref of promptRefs) {
    const image = await loadRef(ref);
    if (image) {
      promptRefImages.push(image);
    }
  }

  const promptImages = mergePromptAttachmentImages({
    imageOrder,
    mediaImageLayout: params.mediaImageLayout ?? inferredMediaImageLayout,
    existingImages: params.existingImages,
    existingImageFactIndexes,
    offloadedImages,
    promptRefImages,
  });

  const sanitizedPromptImages = await sanitizeImageEntriesWithLog(promptImages, "prompt:images", {
    maxBytes: params.maxBytes,
    maxDimensionPx: params.maxDimensionPx,
  });
  const finalized = finalizeRuntimePromptImages(sanitizedPromptImages.entries);

  return {
    ...finalized,
    detectedRefs,
    failedMediaCount: failedMediaCount + sanitizedPromptImages.failedMediaCount,
    loadedCount,
    skippedCount,
  };
}

/** Hydrates native model media while preserving the shipped image-only SDK entry point. */
export async function detectAndLoadPromptMedia(
  params: PromptMediaLoadParams,
): Promise<PromptMediaLoadResult> {
  return await hydrateNativePromptMedia(params, {
    detectImages: detectAndLoadPromptImages,
    loadMedia: loadPromptMediaFromRef,
  });
}

/** Hydrates non-enumerable facts carried by queued user turns before provider replay. */
export async function hydratePromptMediaMessages(
  messages: AgentMessage[],
  options: {
    workspaceDir: string;
    model: { input?: string[] };
    maxBytes?: number;
    maxDimensionPx?: number;
    workspaceOnly?: boolean;
    localRoots?: readonly string[];
    sandbox?: { root: string; bridge: SandboxFsBridge };
  },
): Promise<AgentMessage[]> {
  let hydrated: AgentMessage[] | undefined;
  for (const [index, message] of messages.entries()) {
    if (message.role !== "user") {
      continue;
    }
    const runtimeMedia = readRuntimePromptMediaFacts(message);
    const meta = (message as unknown as Record<string, unknown>)["__openclaw"];
    const resolvedMedia = runtimeMedia ?? readPersistedMediaFacts(message) ?? [];
    const runtimeImageOrder = readRuntimePromptImageOrder(message);
    const mediaImageLayout = readPersistedMediaImageLayout(message);
    if (!resolvedMedia.length) {
      continue;
    }
    const content = Array.isArray(message.content)
      ? message.content
      : [{ type: "text" as const, text: message.content }];
    const existingMedia = content.filter(
      (block): block is MediaContent => block.type === "image" || block.type === "video",
    );
    const existingImages = existingMedia.filter(
      (block): block is ImageContent => block.type === "image",
    );
    const persistedImageFactIndexes = readPersistedImageBlockFactIndexes(message);
    const inlineLayoutFactIndexes = mediaImageLayout?.slots.flatMap((slot) =>
      slot.kind === "inline" ? [slot.factIndex ?? null] : [],
    );
    // Pre-carrier transcripts had no explicit block provenance. Their native
    // image blocks were positionally aligned with the first image facts.
    const legacyImageFactIndexes =
      runtimeMedia === undefined && mediaImageLayout === undefined
        ? collectIdentitylessMediaImageFactIndexes(resolvedMedia)
        : undefined;
    const existingImageFactIndexes =
      persistedImageFactIndexes ??
      (inlineLayoutFactIndexes?.length === existingImages.length
        ? inlineLayoutFactIndexes
        : legacyImageFactIndexes?.slice(0, existingImages.length));
    const result = await detectAndLoadPromptMedia({
      prompt: "",
      media: resolvedMedia,
      workspaceDir: options.workspaceDir,
      model: options.model,
      existingMedia,
      existingImageFactIndexes,
      imageOrder: runtimeImageOrder,
      mediaImageLayout,
      maxBytes: options.maxBytes,
      maxDimensionPx: options.maxDimensionPx,
      workspaceOnly: options.workspaceOnly,
      localRoots: options.localRoots,
      sandbox: options.sandbox,
    });
    const nextMeta =
      meta && typeof meta === "object" && !Array.isArray(meta)
        ? { ...(meta as Record<string, unknown>) }
        : {};
    if (result.images.length > 0) {
      nextMeta.mediaImageBlockFactIndexes = result.imageFactIndexes;
    } else {
      delete nextMeta.mediaImageBlockFactIndexes;
    }
    const omittedVideoBlocks = resolveOmittedPromptVideoBlocks({
      facts: resolvedMedia,
      media: result.media,
      content,
      supportsVideo: options.model.input?.includes("video") ?? false,
    });
    hydrated ??= messages.slice();
    const hydratedMessage = {
      ...message,
      content: [
        ...content.filter((block) => block.type !== "image" && block.type !== "video"),
        ...omittedVideoBlocks,
        ...result.media,
      ],
    } as AgentMessage;
    if (Object.keys(nextMeta).length > 0) {
      (hydratedMessage as unknown as Record<string, unknown>)["__openclaw"] = nextMeta;
    } else {
      delete (hydratedMessage as unknown as Record<string, unknown>)["__openclaw"];
    }
    if (runtimeMedia) {
      attachRuntimePromptMediaFacts(hydratedMessage, runtimeMedia, runtimeImageOrder);
    }
    hydrated[index] = hydratedMessage;
  }
  return hydrated ?? messages;
}
