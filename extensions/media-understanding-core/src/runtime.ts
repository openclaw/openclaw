import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import {
  buildProviderRegistry,
  createMediaAttachmentCache,
  normalizeMediaAttachments,
  normalizeMediaProviderId,
  runCapability,
  type ActiveMediaModel,
} from "openclaw/plugin-sdk/media-runtime";

type MediaUnderstandingCapability = "image" | "audio" | "video";
type MediaUnderstandingOutput = Awaited<ReturnType<typeof runCapability>>["outputs"][number];

const KIND_BY_CAPABILITY: Record<MediaUnderstandingCapability, MediaUnderstandingOutput["kind"]> = {
  audio: "audio.transcription",
  image: "image.description",
  video: "video.description",
};

export type RunMediaUnderstandingFileParams = {
  capability: MediaUnderstandingCapability;
  filePath: string;
  cfg: OpenClawConfig;
  agentDir?: string;
  mime?: string;
  activeModel?: ActiveMediaModel;
};

export type RunMediaUnderstandingFileResult = {
  text: string | undefined;
  provider?: string;
  model?: string;
  output?: MediaUnderstandingOutput;
};

function buildFileContext(params: { filePath: string; mime?: string }) {
  return {
    MediaPath: params.filePath,
    MediaType: params.mime,
  };
}

export async function runMediaUnderstandingFile(
  params: RunMediaUnderstandingFileParams,
): Promise<RunMediaUnderstandingFileResult> {
  const ctx = buildFileContext(params);
  const attachments = normalizeMediaAttachments(ctx);
  if (attachments.length === 0) {
    return { text: undefined };
  }

  const providerRegistry = buildProviderRegistry(undefined, params.cfg);
  const cache = createMediaAttachmentCache(attachments, {
    localPathRoots: [path.dirname(params.filePath)],
  });

  try {
    const result = await runCapability({
      capability: params.capability,
      cfg: params.cfg,
      ctx,
      attachments: cache,
      media: attachments,
      agentDir: params.agentDir,
      providerRegistry,
      config: params.cfg.tools?.media?.[params.capability],
      activeModel: params.activeModel,
    });
    const output = result.outputs.find(
      (entry) => entry.kind === KIND_BY_CAPABILITY[params.capability],
    );
    const text = output?.text?.trim();
    return {
      text: text || undefined,
      provider: output?.provider,
      model: output?.model,
      output,
    };
  } finally {
    await cache.cleanup();
  }
}

export async function describeImageFile(params: {
  filePath: string;
  cfg: OpenClawConfig;
  agentDir?: string;
  mime?: string;
  activeModel?: ActiveMediaModel;
}): Promise<RunMediaUnderstandingFileResult> {
  return await runMediaUnderstandingFile({ ...params, capability: "image" });
}

export async function describeImageFileWithModel(params: {
  filePath: string;
  cfg: OpenClawConfig;
  agentDir?: string;
  mime?: string;
  provider: string;
  model: string;
  prompt: string;
  maxTokens?: number;
  timeoutMs?: number;
}) {
  const timeoutMs = params.timeoutMs ?? 30_000;
  const providerRegistry = buildProviderRegistry(undefined, params.cfg);
  const provider = providerRegistry.get(normalizeMediaProviderId(params.provider));
  if (!provider?.describeImage) {
    throw new Error(`Provider does not support image analysis: ${params.provider}`);
  }
  const buffer = await fs.readFile(params.filePath);
  return await provider.describeImage({
    buffer,
    fileName: path.basename(params.filePath),
    mime: params.mime,
    provider: params.provider,
    model: params.model,
    prompt: params.prompt,
    maxTokens: params.maxTokens,
    timeoutMs,
    cfg: params.cfg,
    agentDir: params.agentDir ?? "",
  });
}

export async function describeVideoFile(params: {
  filePath: string;
  cfg: OpenClawConfig;
  agentDir?: string;
  mime?: string;
  activeModel?: ActiveMediaModel;
}): Promise<RunMediaUnderstandingFileResult> {
  return await runMediaUnderstandingFile({ ...params, capability: "video" });
}

export async function transcribeAudioFile(params: {
  filePath: string;
  cfg: OpenClawConfig;
  agentDir?: string;
  mime?: string;
  activeModel?: ActiveMediaModel;
}): Promise<{ text: string | undefined }> {
  const result = await runMediaUnderstandingFile({ ...params, capability: "audio" });
  return { text: result.text };
}
