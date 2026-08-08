import { kindFromMime, mimeTypeFromFilePath } from "@openclaw/media-core/mime";
import { safeFileURLToPath } from "../../../infra/local-file-access.js";
import type {
  ImageContent,
  MediaContent,
  ModelInputContent,
  VideoContent,
} from "../../../llm/types.js";
import { DEFAULT_MAX_BYTES } from "../../../media-understanding/defaults.constants.js";
import {
  isGenericBinaryMediaContentType,
  normalizeMediaFacts,
  type MediaFact,
} from "../../../media/media-facts.js";
import { classifyMediaReferenceSource } from "../../../media/media-reference.js";
import type { PromptImageOrderEntry } from "../../../media/prompt-image-order.js";
import {
  finalizeRuntimePromptImages,
  readRuntimePromptImageFactIndexes,
} from "../../../media/runtime-prompt-image-provenance.js";
import { resolveUserPath } from "../../../utils.js";
import type { SandboxFsBridge } from "../../sandbox/fs-bridge.js";
import type { ImageFactIndex, MediaImageLayout } from "./prompt-image-metadata.js";

export type DetectedPromptMediaRef = {
  raw: string;
  type: "path" | "media-uri";
  resolved: string;
};

export type PromptImageLoadParams = {
  prompt: string;
  media?: readonly MediaFact[];
  workspaceDir: string;
  model: { input?: string[] };
  existingImages?: ImageContent[];
  existingImageFactIndexes?: readonly ImageFactIndex[];
  imageOrder?: PromptImageOrderEntry[];
  mediaImageLayout?: MediaImageLayout;
  maxBytes?: number;
  maxDimensionPx?: number;
  workspaceOnly?: boolean;
  localRoots?: readonly string[];
  sandbox?: { root: string; bridge: SandboxFsBridge };
};

export type PromptImageLoadResult = {
  images: ImageContent[];
  imageFactIndexes: ImageFactIndex[];
  detectedRefs: DetectedPromptMediaRef[];
  failedMediaCount: number;
  loadedCount: number;
  skippedCount: number;
};

export type PromptMediaLoadParams = Omit<PromptImageLoadParams, "existingImages"> & {
  existingMedia?: MediaContent[];
};

export type PromptMediaLoadResult = PromptImageLoadResult & { media: MediaContent[] };

export type PromptMediaReadOptions = {
  kind: "image" | "video";
  maxBytes?: number;
  workspaceOnly?: boolean;
  localRoots?: readonly string[];
  sandbox?: { root: string; bridge: SandboxFsBridge };
};

type PromptMediaDependencies = {
  detectImages: (params: PromptImageLoadParams) => Promise<PromptImageLoadResult>;
  loadMedia: (
    ref: DetectedPromptMediaRef,
    workspaceDir: string,
    options: PromptMediaReadOptions,
  ) => Promise<MediaContent | null>;
};

type PromptMediaEntry = { media: MediaContent; factIndex: ImageFactIndex };

function isVideoMediaFact(fact: MediaFact): boolean {
  if (fact.kind && fact.kind !== "unknown") {
    return fact.kind === "video";
  }
  if (fact.contentType && !isGenericBinaryMediaContentType(fact.contentType)) {
    return fact.contentType === "video" || kindFromMime(fact.contentType) === "video";
  }
  return kindFromMime(mimeTypeFromFilePath(fact.path ?? fact.url ?? fact.fileName)) === "video";
}

function videoFactReference(fact: MediaFact): DetectedPromptMediaRef | undefined {
  const inboundUri = [fact.url, fact.path].find((value) => value?.startsWith("media://inbound/"));
  const identity = inboundUri ?? fact.path ?? fact.url;
  if (!identity) {
    return undefined;
  }
  const classification = classifyMediaReferenceSource(identity);
  if (classification.isHttpUrl || classification.isDataUrl || classification.hasUnsupportedScheme) {
    return undefined;
  }
  let resolved = identity;
  if (classification.isFileUrl) {
    try {
      resolved = safeFileURLToPath(identity);
    } catch {
      return undefined;
    }
  } else if (resolved.startsWith("~")) {
    resolved = resolveUserPath(resolved);
  }
  return { raw: identity, resolved, type: inboundUri ? "media-uri" : "path" };
}

function videoFitsNativeLimit(video: VideoContent): boolean {
  if (
    kindFromMime(video.mimeType) !== "video" ||
    !video.data ||
    video.data.length % 4 === 1 ||
    !/^[A-Za-z0-9+/]+={0,2}$/u.test(video.data)
  ) {
    return false;
  }
  const padding = video.data.endsWith("==") ? 2 : video.data.endsWith("=") ? 1 : 0;
  return (
    (padding === 0 || video.data.length % 4 === 0) &&
    Math.floor((video.data.length * 3) / 4) - padding <= DEFAULT_MAX_BYTES.video
  );
}

/** Hydrates image/video facts through the image owner's existing secure read boundary. */
export async function hydrateNativePromptMedia(
  params: PromptMediaLoadParams,
  dependencies: PromptMediaDependencies,
): Promise<PromptMediaLoadResult> {
  const existingMedia = params.existingMedia ?? [];
  const existingMediaFactIndexes = readRuntimePromptImageFactIndexes(existingMedia);
  const existingImageFactIndexes =
    params.existingImageFactIndexes ??
    existingMediaFactIndexes?.filter((_factIndex, index) => existingMedia[index]?.type === "image");
  const imageResult = await dependencies.detectImages({
    ...params,
    existingImages: existingMedia.filter((media): media is ImageContent => media.type === "image"),
    existingImageFactIndexes,
  });
  if (!params.model.input?.includes("video")) {
    return { ...imageResult, media: imageResult.images };
  }

  const videoFacts = normalizeMediaFacts(params.media).flatMap((fact, factIndex) =>
    isVideoMediaFact(fact) ? [{ fact, factIndex }] : [],
  );
  const existingVideos = existingMedia.flatMap((media, index) =>
    media.type === "video" ? [{ video: media, factIndex: existingMediaFactIndexes?.[index] }] : [],
  );
  if (videoFacts.length === 0 && existingVideos.length === 0) {
    return { ...imageResult, media: imageResult.images };
  }

  const videoEntries: PromptMediaEntry[] = [];
  const videoRefs: DetectedPromptMediaRef[] = [];
  let failedMediaCount = imageResult.failedMediaCount;
  let loadedCount = imageResult.loadedCount;
  let skippedCount = imageResult.skippedCount;
  for (const { fact, factIndex } of videoFacts) {
    if (fact.hydrationSuppressed === true) {
      const suppressedVideoIndex = existingVideos.findIndex(
        (entry) => entry.factIndex === factIndex,
      );
      if (suppressedVideoIndex >= 0) {
        existingVideos.splice(suppressedVideoIndex, 1);
      }
      continue;
    }
    if (fact.sizeBytes !== undefined && fact.sizeBytes > DEFAULT_MAX_BYTES.video) {
      const oversizedVideoIndex = existingVideos.findIndex(
        (entry) => entry.factIndex === factIndex,
      );
      if (oversizedVideoIndex >= 0) {
        existingVideos.splice(oversizedVideoIndex, 1);
      }
      failedMediaCount++;
      skippedCount++;
      continue;
    }
    const existingVideoIndex = existingVideos.findIndex(
      (entry) => entry.factIndex === factIndex || entry.factIndex === undefined,
    );
    const existingVideo =
      existingVideoIndex >= 0 ? existingVideos.splice(existingVideoIndex, 1)[0]?.video : undefined;
    if (existingVideo && !videoFitsNativeLimit(existingVideo)) {
      failedMediaCount++;
      skippedCount++;
      continue;
    }
    if (existingVideo) {
      videoEntries.push({ media: existingVideo, factIndex });
      continue;
    }
    const ref = videoFactReference(fact);
    if (!ref) {
      failedMediaCount++;
      skippedCount++;
      continue;
    }
    videoRefs.push(ref);
    const loaded = await dependencies.loadMedia(ref, fact.workspaceDir ?? params.workspaceDir, {
      kind: "video",
      maxBytes: DEFAULT_MAX_BYTES.video,
      workspaceOnly: params.workspaceOnly,
      localRoots: params.localRoots ?? (params.workspaceOnly ? [params.workspaceDir] : undefined),
      sandbox: params.sandbox,
    });
    if (loaded?.type === "video") {
      videoEntries.push({ media: loaded, factIndex });
      loadedCount++;
    } else {
      failedMediaCount++;
      skippedCount++;
    }
  }
  for (const { video, factIndex } of existingVideos) {
    if (videoFitsNativeLimit(video)) {
      videoEntries.push({ media: video, factIndex: factIndex ?? null });
    } else {
      failedMediaCount++;
      skippedCount++;
    }
  }

  const imageEntries: PromptMediaEntry[] = imageResult.images.map((image, index) => ({
    media: image,
    factIndex: imageResult.imageFactIndexes[index] ?? null,
  }));
  const entries = [...imageEntries, ...videoEntries];
  const factOwned = entries
    .filter((entry) => entry.factIndex !== null)
    .toSorted((left, right) => (left.factIndex ?? 0) - (right.factIndex ?? 0));
  const unowned = entries.filter((entry) => entry.factIndex === null);
  const existingOrder = existingMedia.flatMap((media) => {
    const index = unowned.findIndex((entry) => entry.media === media);
    return index >= 0 ? unowned.splice(index, 1) : [];
  });
  const finalized = finalizeRuntimePromptImages(
    [...factOwned, ...existingOrder, ...unowned].map(({ media, factIndex }) => ({
      image: media,
      factIndex,
    })),
  );
  return {
    media: finalized.images,
    images: imageResult.images,
    imageFactIndexes: imageResult.imageFactIndexes,
    detectedRefs: [...imageResult.detectedRefs, ...videoRefs],
    failedMediaCount,
    loadedCount,
    skippedCount,
  };
}

/** Explains unavailable video facts once so persisted replay cannot silently lose input. */
export function resolveOmittedPromptVideoBlocks(params: {
  facts: readonly MediaFact[];
  media: MediaContent[];
  content: readonly ModelInputContent[];
  supportsVideo: boolean;
}): Array<{ type: "text"; text: string }> {
  const deliveredVideoFacts = new Set(
    (readRuntimePromptImageFactIndexes(params.media) ?? []).flatMap((factIndex, mediaIndex) =>
      params.media[mediaIndex]?.type === "video" && factIndex !== null ? [factIndex] : [],
    ),
  );
  const omittedVideoText = params.supportsVideo
    ? "(video omitted: attachment is unavailable)"
    : "(video omitted: model does not support videos)";
  let existingOmissionCount = params.content.filter(
    (block) => block.type === "text" && block.text === omittedVideoText,
  ).length;
  return params.facts.flatMap((fact, factIndex) => {
    if (
      !isVideoMediaFact(fact) ||
      fact.hydrationSuppressed === true ||
      deliveredVideoFacts.has(factIndex) ||
      (params.supportsVideo &&
        fact.sizeBytes !== undefined &&
        fact.sizeBytes > DEFAULT_MAX_BYTES.video)
    ) {
      return [];
    }
    if (existingOmissionCount > 0) {
      existingOmissionCount--;
      return [];
    }
    return [{ type: "text" as const, text: omittedVideoText }];
  });
}
