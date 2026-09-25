import {
  embeddedAgentLog,
  type EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams,
  type MessagingToolSend,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  generatedImageAssetFromBase64,
  parseImageDataUrl,
} from "openclaw/plugin-sdk/image-generation";
import { sanitizeInlineImageDataUrl } from "openclaw/plugin-sdk/inline-image-data-url-runtime";
import { resolveGeneratedMediaMaxBytes } from "openclaw/plugin-sdk/media-generation-runtime";
import {
  normalizeMediaReferenceForComparison,
  saveMediaBuffer,
} from "openclaw/plugin-sdk/media-store";
import { isRecord, readStringField as readString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { CodexConfirmedMediaDelivery } from "./dynamic-tools.js";
import { readItemString } from "./event-projector-values.js";
import type { CodexThreadItem, JsonObject } from "./protocol.js";
import type { CodexRemoteWorkspaceFileReader } from "./remote-workspace-media.js";

const GENERATED_IMAGE_MEDIA_SUBDIR = "tool-image-generation";
const TOOL_OUTPUT_IMAGE_MEDIA_SUBDIR = "tool-output-images";
const MAX_TOOL_OUTPUT_IMAGES = 8;

type CodexProjectedImageSource = "native" | "raw" | "tool-output";
type PreparedToolOutputImage = {
  itemId: string;
  outputIds: readonly string[];
  base64: string;
  mimeType: string;
};

export class CodexGeneratedMediaProjection {
  private readonly itemIds = new Set<string>();
  private readonly generatedItemIds = new Set<string>();
  private readonly mediaByItemId = new Map<string, { mediaUrl?: string; savedPath?: string }>();
  private readonly gatewayMaterializedItemIds = new Set<string>();
  private readonly pendingMaterializationsByItemId = new Map<string, Promise<void>>();
  private readonly observedToolOutputImageIds = new Set<string>();
  private readonly byteBudgetedToolOutputImageIds = new Set<string>();
  private readonly hostDynamicToolCallIds = new Set<string>();
  private readonly nativeImageViewPathById = new Map<string, string>();
  private readonly toolOutputImageItemIdsByOutputId = new Map<string, Set<string>>();
  private readonly pendingFunctionToolOutputs = new Map<
    string,
    { outputIds: readonly string[]; images: PreparedToolOutputImage[] }
  >();
  private toolOutputImageBytes = 0;

  constructor(
    private readonly config: EmbeddedRunAttemptParams["config"],
    private readonly remote?: {
      remoteWorkspaceRoot?: string;
      readFile?: CodexRemoteWorkspaceFileReader;
      requestTimeoutMs?: number;
      signal?: AbortSignal;
    },
  ) {}

  hasGeneratedMedia(): boolean {
    return this.generatedItemIds.size > 0;
  }

  async recordItemIdentity(item: CodexThreadItem | undefined): Promise<void> {
    if (!item?.id) {
      return;
    }
    if (item.type === "dynamicToolCall") {
      this.hostDynamicToolCallIds.add(item.id);
      for (const [outputId, pending] of this.pendingFunctionToolOutputs) {
        if (pending.outputIds.includes(item.id)) {
          this.pendingFunctionToolOutputs.delete(outputId);
        }
      }
      return;
    }
    if (item.type !== "imageView") {
      return;
    }
    const sourcePath = readItemString(item, "path")?.trim();
    if (!sourcePath) {
      return;
    }
    this.nativeImageViewPathById.set(item.id, sourcePath);
    for (const itemId of this.toolOutputImageItemIdsByOutputId.get(item.id) ?? []) {
      this.mediaByItemId.set(itemId, { ...this.mediaByItemId.get(itemId), savedPath: sourcePath });
    }
    for (const [outputId, pending] of this.pendingFunctionToolOutputs) {
      if (!pending.outputIds.includes(item.id)) {
        continue;
      }
      this.pendingFunctionToolOutputs.delete(outputId);
      await this.materializePreparedToolOutputImages(pending.images, sourcePath);
    }
  }

  async recordNative(item: CodexThreadItem | undefined): Promise<void> {
    await this.recordItemIdentity(item);
    if (item?.type !== "imageGeneration") {
      return;
    }
    // Image generation is already a billable side effect even if its remote
    // artifact cannot be transferred into this gateway's media store.
    this.generatedItemIds.add(item.id);
    this.itemIds.add(item.id);
    const savedPath = readItemString(item, "savedPath")?.trim();
    if (savedPath) {
      this.mediaByItemId.set(item.id, { ...this.mediaByItemId.get(item.id), savedPath });
    }
    const result = readItemString(item, "result");
    if (result) {
      await this.recordImage({
        itemId: item.id,
        result,
        revisedPrompt: readItemString(item, "revisedPrompt"),
        source: "native",
      });
      return;
    }
    if (savedPath) {
      if (this.remote?.remoteWorkspaceRoot) {
        if (!this.remote.readFile) {
          embeddedAgentLog.warn("codex remote image has no app-server file transfer", {
            itemId: item.id,
          });
          return;
        }
        try {
          const response = await this.remote.readFile({
            path: savedPath,
            maxBytes: resolveGeneratedMediaMaxBytes(this.config, "image"),
            signal: this.remote.signal,
            timeoutMs: this.remote.requestTimeoutMs,
          });
          if (!response || typeof response.dataBase64 !== "string" || !response.dataBase64) {
            embeddedAgentLog.warn("codex remote image file returned no inline bytes", {
              itemId: item.id,
            });
            return;
          }
          await this.recordImage({
            itemId: item.id,
            result: response.dataBase64,
            revisedPrompt: readItemString(item, "revisedPrompt"),
            source: "native",
          });
        } catch (error) {
          embeddedAgentLog.warn("codex app-server remote image file read failed", {
            itemId: item.id,
            error,
          });
        }
        return;
      }
      this.recordUrl({ itemId: item.id, mediaUrl: savedPath });
    }
  }

  async recordRaw(item: JsonObject): Promise<void> {
    const type = readString(item, "type");
    if (type === "custom_tool_call_output") {
      const outputIds = readRawToolOutputIds(item);
      if (outputIds.some((id) => this.hostDynamicToolCallIds.has(id))) {
        return;
      }
      await this.recordRawToolOutputImages(item, outputIds);
      return;
    }
    if (type === "function_call_output") {
      const outputIds = readRawToolOutputIds(item);
      // Function outputs also carry OpenClaw dynamic-tool results. Only a
      // correlated Codex-native imageView may promote its model input into a
      // host-owned reply attachment; unknown and explicitly host-owned calls
      // fail closed so media.outbound=false cannot be bypassed.
      if (outputIds.some((id) => this.hostDynamicToolCallIds.has(id))) {
        return;
      }
      const outputId = outputIds[0];
      if (!outputId || this.pendingFunctionToolOutputs.has(outputId)) {
        return;
      }
      const images = this.prepareRawToolOutputImages(item, outputIds);
      if (images.length === 0) {
        return;
      }
      const sourcePath = outputIds
        .map((id) => this.nativeImageViewPathById.get(id))
        .find((candidate): candidate is string => Boolean(candidate));
      if (sourcePath) {
        await this.materializePreparedToolOutputImages(images, sourcePath);
      } else {
        // Prepared bytes have already passed the same projection-wide count
        // and decoded-byte budgets as immediately materialized images. Keep
        // them only until a matching native imageView or host dynamic call
        // establishes ownership for this turn.
        this.pendingFunctionToolOutputs.set(outputId, { outputIds, images });
      }
      return;
    }
    if (type !== "image_generation_call") {
      return;
    }
    const result = readString(item, "result");
    if (!result) {
      return;
    }
    const itemId = readString(item, "id") ?? `raw-image-${this.itemIds.size}`;
    this.generatedItemIds.add(itemId);
    await this.recordImage({
      itemId,
      result,
      revisedPrompt: readString(item, "revised_prompt") ?? readString(item, "revisedPrompt"),
      source: "raw",
    });
  }

  private async recordRawToolOutputImages(
    item: JsonObject,
    outputIds: readonly string[],
  ): Promise<void> {
    await this.materializePreparedToolOutputImages(
      this.prepareRawToolOutputImages(item, outputIds),
    );
  }

  private prepareRawToolOutputImages(
    item: JsonObject,
    outputIds: readonly string[],
  ): PreparedToolOutputImage[] {
    if (!Array.isArray(item.output)) {
      return [];
    }
    const outputId = outputIds[0];
    if (!outputId) {
      return [];
    }
    const images: PreparedToolOutputImage[] = [];
    const maxBytes = resolveGeneratedMediaMaxBytes(this.config, "image");
    for (const [index, content] of item.output.entries()) {
      if (!isRecord(content) || content.type !== "input_image") {
        continue;
      }
      const itemId = `${outputId}:input-image:${index}`;
      for (const identity of outputIds) {
        const itemIds = this.toolOutputImageItemIdsByOutputId.get(identity) ?? new Set<string>();
        itemIds.add(itemId);
        this.toolOutputImageItemIdsByOutputId.set(identity, itemIds);
      }
      if (
        !this.observedToolOutputImageIds.has(itemId) &&
        this.observedToolOutputImageIds.size >= MAX_TOOL_OUTPUT_IMAGES
      ) {
        embeddedAgentLog.warn("codex app-server tool output image count exceeds limit", {
          outputId,
          maxImages: MAX_TOOL_OUTPUT_IMAGES,
        });
        return images;
      }
      this.observedToolOutputImageIds.add(itemId);
      const imageUrl = readString(content, "image_url");
      if (!imageUrl?.toLowerCase().startsWith("data:")) {
        continue;
      }
      const commaIndex = imageUrl.indexOf(",");
      if (commaIndex < 0) {
        continue;
      }
      const estimatedDecodedBytes = estimateBase64DecodedBytes(imageUrl.slice(commaIndex + 1));
      if (estimatedDecodedBytes !== undefined && estimatedDecodedBytes > maxBytes) {
        embeddedAgentLog.warn("codex app-server tool output image exceeds media limit", {
          itemId,
          estimatedDecodedBytes,
          maxBytes,
        });
        continue;
      }
      const sanitized = sanitizeInlineImageDataUrl(imageUrl);
      const parsed = sanitized ? parseImageDataUrl(sanitized) : undefined;
      if (!parsed) {
        continue;
      }
      const decodedBytes = estimateBase64DecodedBytes(parsed.base64);
      if (decodedBytes === undefined) {
        continue;
      }
      if (!this.byteBudgetedToolOutputImageIds.has(itemId)) {
        if (this.toolOutputImageBytes + decodedBytes > maxBytes) {
          embeddedAgentLog.warn(
            "codex app-server tool output images exceed aggregate media limit",
            {
              itemId,
              aggregateDecodedBytes: this.toolOutputImageBytes,
              decodedBytes,
              maxBytes,
            },
          );
          continue;
        }
        this.toolOutputImageBytes += decodedBytes;
        this.byteBudgetedToolOutputImageIds.add(itemId);
      }
      images.push({
        itemId,
        outputIds,
        base64: parsed.base64,
        mimeType: parsed.mimeType,
      });
    }
    return images;
  }

  private async materializePreparedToolOutputImages(
    images: readonly PreparedToolOutputImage[],
    knownSourcePath?: string,
  ): Promise<void> {
    for (const image of images) {
      const sourcePath =
        knownSourcePath ??
        image.outputIds
          .map((identity) => this.nativeImageViewPathById.get(identity))
          .find((candidate): candidate is string => Boolean(candidate));
      if (sourcePath) {
        this.mediaByItemId.set(image.itemId, {
          ...this.mediaByItemId.get(image.itemId),
          savedPath: sourcePath,
        });
      }
      await this.recordImage({
        itemId: image.itemId,
        result: image.base64,
        mimeType: image.mimeType,
        source: "tool-output",
      });
    }
  }

  private async recordImage(params: {
    itemId: string;
    result: string;
    mimeType?: string;
    revisedPrompt?: string;
    source: CodexProjectedImageSource;
  }): Promise<void> {
    this.itemIds.add(params.itemId);
    if (this.gatewayMaterializedItemIds.has(params.itemId)) {
      return;
    }
    let pending = this.pendingMaterializationsByItemId.get(params.itemId);
    while (pending) {
      await pending;
      if (this.gatewayMaterializedItemIds.has(params.itemId)) {
        return;
      }
      // A malformed, oversized, or failed sibling event must not suppress a
      // valid completion carrying the same Codex image item.
      pending = this.pendingMaterializationsByItemId.get(params.itemId);
    }

    const materialization = this.materializeImage(params);
    this.pendingMaterializationsByItemId.set(params.itemId, materialization);
    try {
      await materialization;
    } finally {
      if (this.pendingMaterializationsByItemId.get(params.itemId) === materialization) {
        this.pendingMaterializationsByItemId.delete(params.itemId);
      }
    }
  }

  private async materializeImage(params: {
    itemId: string;
    result: string;
    mimeType?: string;
    revisedPrompt?: string;
    source: CodexProjectedImageSource;
  }): Promise<void> {
    const maxBytes = resolveGeneratedMediaMaxBytes(this.config, "image");
    const estimatedDecodedBytes = estimateBase64DecodedBytes(params.result);
    if (estimatedDecodedBytes !== undefined && estimatedDecodedBytes > maxBytes) {
      embeddedAgentLog.warn(
        params.source === "tool-output"
          ? "codex app-server tool output image exceeds media limit"
          : `codex app-server ${params.source} image generation result exceeds media limit`,
        {
          itemId: params.itemId,
          estimatedDecodedBytes,
          maxBytes,
        },
      );
      return;
    }
    const asset = generatedImageAssetFromBase64({
      base64: params.result,
      index: this.itemIds.size,
      mimeType: params.mimeType,
      revisedPrompt: params.revisedPrompt,
      fileNamePrefix:
        params.source === "tool-output" ? "codex-tool-output-image" : "codex-image-generation",
      sniffMimeType: params.mimeType === undefined,
    });
    if (!asset) {
      return;
    }
    try {
      const saved = await saveMediaBuffer(
        asset.buffer,
        asset.mimeType,
        params.source === "tool-output"
          ? TOOL_OUTPUT_IMAGE_MEDIA_SUBDIR
          : GENERATED_IMAGE_MEDIA_SUBDIR,
        maxBytes,
        asset.fileName,
      );
      this.gatewayMaterializedItemIds.add(params.itemId);
      this.recordUrl({
        itemId: params.itemId,
        mediaUrl: saved.path,
        // Both Codex event shapes can carry a DevBox-local savedPath; channel
        // delivery must always use the copy materialized on this gateway.
        replaceExisting: true,
      });
    } catch (error) {
      embeddedAgentLog.warn(
        params.source === "tool-output"
          ? "codex app-server tool output image save failed"
          : `codex app-server ${params.source} image generation result save failed`,
        {
          itemId: params.itemId,
          error,
        },
      );
    }
  }

  projectDelivery(params: {
    toolMediaUrls?: string[];
    messagingToolSentMediaUrls: string[];
    messagingToolSentTargets: MessagingToolSend[];
    confirmedMediaDeliveries?: readonly CodexConfirmedMediaDelivery[];
  }) {
    const generatedUrls = new Set<string>();
    const generatedUrlBySource = new Map<string, string>();
    for (const { mediaUrl, savedPath } of this.mediaByItemId.values()) {
      if (!mediaUrl) {
        continue;
      }
      generatedUrls.add(mediaUrl);
      generatedUrlBySource.set(normalizeMediaReferenceForComparison(mediaUrl), mediaUrl);
      if (savedPath) {
        generatedUrlBySource.set(normalizeMediaReferenceForComparison(savedPath), mediaUrl);
      }
    }
    const sentMediaUrls = new Set(params.messagingToolSentMediaUrls);
    const generatedUrlsByTarget = new Map<MessagingToolSend, Set<string>>();
    for (const delivery of params.confirmedMediaDeliveries ?? []) {
      for (const sourceUrl of delivery.sourceUrls) {
        const generatedUrl = generatedUrlBySource.get(
          normalizeMediaReferenceForComparison(sourceUrl),
        );
        if (!generatedUrl) {
          continue;
        }
        if (delivery.kind === "sourceReply") {
          // The source reply already owns its real attachment and transcript mirror.
          generatedUrls.delete(generatedUrl);
        } else {
          const targetUrls = generatedUrlsByTarget.get(delivery.target) ?? new Set<string>();
          targetUrls.add(generatedUrl);
          generatedUrlsByTarget.set(delivery.target, targetUrls);
          sentMediaUrls.add(generatedUrl);
        }
      }
    }
    const mediaUrls = new Set(params.toolMediaUrls?.map((url) => url.trim()).filter(Boolean) ?? []);
    for (const mediaUrl of generatedUrls) {
      mediaUrls.add(mediaUrl);
    }
    return {
      toolMediaUrls: mediaUrls.size > 0 ? [...mediaUrls] : params.toolMediaUrls,
      hostOwnedToolMediaUrls: generatedUrls.size > 0 ? [...generatedUrls] : undefined,
      messagingToolSentMediaUrls: [...sentMediaUrls],
      messagingToolSentTargets: params.messagingToolSentTargets.map((target) => {
        const aliases = generatedUrlsByTarget.get(target);
        return aliases
          ? { ...target, mediaUrls: [...new Set([...(target.mediaUrls ?? []), ...aliases])] }
          : target;
      }),
    };
  }

  private recordUrl(params: { itemId: string; mediaUrl: string; replaceExisting?: boolean }): void {
    const existing = this.mediaByItemId.get(params.itemId);
    if (existing?.mediaUrl && params.replaceExisting !== true) {
      this.itemIds.add(params.itemId);
      return;
    }
    this.mediaByItemId.set(params.itemId, { ...existing, mediaUrl: params.mediaUrl });
    this.itemIds.add(params.itemId);
  }
}

function estimateBase64DecodedBytes(base64: string): number | undefined {
  let nonWhitespaceLength = 0;
  let previousCode = -1;
  let lastCode = -1;
  for (let i = 0; i < base64.length; i += 1) {
    const code = base64.charCodeAt(i);
    if (isBase64WhitespaceCode(code)) {
      continue;
    }
    nonWhitespaceLength += 1;
    previousCode = lastCode;
    lastCode = code;
  }
  if (nonWhitespaceLength === 0) {
    return undefined;
  }
  const equalsCode = "=".charCodeAt(0);
  const padding = lastCode === equalsCode ? (previousCode === equalsCode ? 2 : 1) : 0;
  return Math.max(0, Math.floor((nonWhitespaceLength * 3) / 4) - padding);
}

function readRawToolOutputIds(item: JsonObject): string[] {
  return [readString(item, "id"), readString(item, "call_id")].filter(
    (value, index, values): value is string => Boolean(value) && values.indexOf(value) === index,
  );
}

function isBase64WhitespaceCode(code: number): boolean {
  return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d;
}
