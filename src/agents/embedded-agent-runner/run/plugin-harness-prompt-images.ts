import { MAX_IMAGE_BYTES } from "@openclaw/media-core/constants";
import { isImageMediaFact, readPersistedMediaFacts } from "../../../media/media-facts.js";
import { readRuntimePromptImageFactIndexes } from "../../../media/runtime-prompt-image-provenance.js";
import { resolveImageSanitizationLimits } from "../../image-sanitization.js";
import { resolveAttemptWorkspaceSandbox } from "./attempt-setup.js";
import { detectAndLoadPromptMedia } from "./images.js";
import type { RunEmbeddedAgentParams } from "./params.js";
import { readPersistedMediaImageLayout } from "./prompt-image-metadata.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

function toTypeOnlyMediaFact(
  fact: NonNullable<RunEmbeddedAgentParams["media"]>[number],
  hydrationSuppressed: boolean,
): NonNullable<RunEmbeddedAgentParams["media"]>[number] {
  const video = fact.kind === "video" || fact.contentType?.startsWith("video/") === true;
  return {
    contentType: fact.contentType,
    kind: video ? "video" : fact.kind === "sticker" ? "sticker" : "image",
    ...(video && fact.sizeBytes !== undefined ? { sizeBytes: fact.sizeBytes } : {}),
    messageId: fact.messageId,
    transcribed: fact.transcribed,
    ...(fact.hydrationSuppressed === true || hydrationSuppressed
      ? { hydrationSuppressed: true }
      : {}),
  };
}

/** Materializes fact-carried native media before a plugin harness owns transport. */
export async function preparePluginHarnessPromptImages(params: {
  runParams: RunEmbeddedAgentParams;
  runtime: {
    sessionId: string;
    sessionKey?: string;
    workspaceDir: string;
    model: EmbeddedRunAttemptParams["model"];
  };
  pluginHarnessOwnsTransport: boolean;
}): Promise<{
  inputMedia?: RunEmbeddedAgentParams["inputMedia"];
  images: RunEmbeddedAgentParams["images"];
  imageOrder: RunEmbeddedAgentParams["imageOrder"];
  media: RunEmbeddedAgentParams["media"];
}> {
  const { runParams, runtime } = params;
  if (!params.pluginHarnessOwnsTransport) {
    return {
      ...(runParams.inputMedia ? { inputMedia: runParams.inputMedia } : {}),
      images: runParams.images,
      imageOrder: runParams.imageOrder,
      media: runParams.media,
    };
  }
  const supportsVideo = runtime.model.input.includes("video");
  const requestedInputMedia = runParams.inputMedia;
  const inputMedia =
    supportsVideo || !requestedInputMedia?.some((media) => media.type === "video")
      ? requestedInputMedia
      : requestedInputMedia.filter((media) => media.type !== "video");
  const existingMedia = inputMedia ?? runParams.images;
  const passthrough = () => ({
    ...(inputMedia ? { inputMedia } : {}),
    images: runParams.images,
    imageOrder: runParams.imageOrder,
    media: runParams.media,
  });
  const persistedMessage =
    runParams.userTurnTranscriptRecorder?.message ??
    (await runParams.userTurnTranscriptRecorder?.resolveMessage());
  const persistedMedia = persistedMessage ? (readPersistedMediaFacts(persistedMessage) ?? []) : [];
  const hydrationMedia = persistedMedia.length > 0 ? persistedMedia : runParams.media;
  if (
    !hydrationMedia?.some(
      (fact) =>
        isImageMediaFact(fact) ||
        (supportsVideo &&
          fact.hydrationSuppressed !== true &&
          (fact.kind === "video" || fact.contentType?.startsWith("video/") === true)),
    )
  ) {
    return passthrough();
  }

  const workspace = await resolveAttemptWorkspaceSandbox({
    ...runParams,
    cwd: undefined,
    sessionId: runtime.sessionId,
    sessionKey: runtime.sessionKey,
    workspaceDir: runtime.workspaceDir,
  });
  const result = await detectAndLoadPromptMedia({
    prompt: "",
    media: hydrationMedia,
    mediaImageLayout: persistedMessage
      ? readPersistedMediaImageLayout(persistedMessage)
      : undefined,
    workspaceDir: workspace.effectiveWorkspace,
    model: runtime.model,
    existingMedia,
    imageOrder: runParams.imageOrder,
    maxBytes: MAX_IMAGE_BYTES,
    maxDimensionPx: resolveImageSanitizationLimits(runParams.config).maxDimensionPx,
    localRoots: workspace.effectiveFsWorkspaceOnly
      ? [workspace.effectiveWorkspace, workspace.resolvedWorkspace]
      : undefined,
    workspaceOnly: workspace.effectiveFsWorkspaceOnly,
    sandbox:
      workspace.sandbox?.enabled && workspace.sandbox.fsBridge
        ? { root: workspace.sandbox.workspaceDir, bridge: workspace.sandbox.fsBridge }
        : undefined,
  });
  if (result.failedMediaCount > 0) {
    const attachmentKind = result.media.some((part) => part.type === "video") ? "media" : "image";
    throw new Error(
      `failed to hydrate ${result.failedMediaCount} structured ${attachmentKind} attachment(s) for plugin harness input`,
    );
  }
  const materializedFactIndexes = new Set(
    (readRuntimePromptImageFactIndexes(result.media) ?? result.imageFactIndexes).filter(
      (index): index is number => index !== null,
    ),
  );
  const retainedMedia = hydrationMedia?.map((fact, factIndex) =>
    isImageMediaFact(fact) ||
    (supportsVideo && (fact.kind === "video" || fact.contentType?.startsWith("video/") === true))
      ? toTypeOnlyMediaFact(fact, !materializedFactIndexes.has(factIndex))
      : fact,
  );
  return {
    ...(inputMedia || result.media.some((part) => part.type === "video")
      ? { inputMedia: result.media }
      : {}),
    images: result.images,
    imageOrder: result.images.length > 0 ? result.images.map(() => "inline" as const) : undefined,
    media: retainedMedia?.length ? retainedMedia : undefined,
  };
}
