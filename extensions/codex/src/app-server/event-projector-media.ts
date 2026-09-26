import {
  embeddedAgentLog,
  type EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams,
  type MessagingToolSend,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import type { AgentHarnessToolResultTelemetry } from "openclaw/plugin-sdk/agent-harness-tool-runtime";
import { generatedImageAssetFromBase64 } from "openclaw/plugin-sdk/image-generation";
import { resolveGeneratedMediaMaxBytes } from "openclaw/plugin-sdk/media-generation-runtime";
import {
  normalizeMediaReferenceForComparison,
  saveMediaBuffer,
} from "openclaw/plugin-sdk/media-store";
import { readStringField as readString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { readItemString } from "./event-projector-values.js";
import { isJsonObject, type CodexThreadItem, type JsonObject } from "./protocol.js";
import type { CodexRemoteWorkspaceFileReader } from "./remote-workspace-media.js";

const GENERATED_IMAGE_MEDIA_SUBDIR = "tool-image-generation";
const MAX_TOOL_OUTPUT_IMAGE_DATA_URL_HEADER_CHARS = 256;

export class CodexGeneratedMediaProjection {
  private readonly mediaItemIds = new Set<string>();
  private readonly generatedItemIds = new Set<string>();
  private readonly hostDynamicToolCallIds = new Set<string>();
  private readonly sourcePathByViewedImageCallId = new Map<string, string>();
  private readonly mediaByItemId = new Map<string, { mediaUrl?: string; savedPath?: string }>();
  private readonly gatewayMaterializedItemIds = new Set<string>();
  private readonly pendingMaterializationsByItemId = new Map<string, Promise<void>>();

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

  /**
   * Host dynamic tools enforce their own outbound policy on result media, so
   * raw Codex echoes of their call ids must never republish those bytes.
   */
  recordDynamicToolCall(params: { callId: string }): void {
    this.hostDynamicToolCallIds.add(params.callId);
  }

  async recordNative(item: CodexThreadItem | undefined): Promise<void> {
    if (item?.type === "imageView") {
      // Codex tags ImageView with the raw call id and image path
      // (view_image.rs ImageViewItem), retaining the source identity that
      // confirmed original-path delivery matching needs.
      const sourcePath = readItemString(item, "path")?.trim();
      if (sourcePath) {
        this.recordViewedImageSourcePath(item.id, sourcePath);
      }
      return;
    }
    if (item?.type !== "imageGeneration") {
      return;
    }
    // Image generation is already a billable side effect even if its remote
    // artifact cannot be transferred into this gateway's media store.
    this.generatedItemIds.add(item.id);
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
    if (type === "custom_tool_call_output" || type === "function_call_output") {
      await this.recordToolOutputImages(item);
      return;
    }
    if (type !== "image_generation_call") {
      return;
    }
    const result = readString(item, "result");
    if (!result) {
      return;
    }
    const itemId = readString(item, "id") ?? `raw-image-${this.generatedItemIds.size}`;
    await this.recordImage({
      itemId,
      result,
      revisedPrompt: readString(item, "revised_prompt") ?? readString(item, "revisedPrompt"),
      source: "raw",
    });
  }

  private async recordImage(params: {
    itemId: string;
    result: string;
    revisedPrompt?: string;
    source: "native" | "raw" | "tool-output";
    requireImageBytes?: boolean;
  }): Promise<void> {
    this.mediaItemIds.add(params.itemId);
    if (params.source !== "tool-output") {
      this.generatedItemIds.add(params.itemId);
    }
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
    revisedPrompt?: string;
    source: "native" | "raw" | "tool-output";
    requireImageBytes?: boolean;
  }): Promise<void> {
    const maxBytes = resolveGeneratedMediaMaxBytes(this.config, "image");
    const estimatedDecodedBytes = estimateBase64DecodedBytes(params.result);
    if (estimatedDecodedBytes !== undefined && estimatedDecodedBytes > maxBytes) {
      embeddedAgentLog.warn(
        `codex app-server ${imageSourceDescription(params.source)} exceeds media limit`,
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
      index: this.mediaItemIds.size,
      revisedPrompt: params.revisedPrompt,
      defaultMimeType: params.requireImageBytes ? "application/octet-stream" : undefined,
      fileNamePrefix:
        params.source === "tool-output" ? "codex-tool-output-image" : "codex-image-generation",
      sniffMimeType: true,
    });
    if (!asset || (params.requireImageBytes && !asset.mimeType.startsWith("image/"))) {
      return;
    }
    try {
      const saved = await saveMediaBuffer(
        asset.buffer,
        asset.mimeType,
        GENERATED_IMAGE_MEDIA_SUBDIR,
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
        `codex app-server ${imageSourceDescription(params.source)} save failed`,
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
    confirmedMediaDeliveries?: Readonly<
      AgentHarnessToolResultTelemetry["confirmedMediaDeliveries"]
    >;
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
      this.mediaItemIds.add(params.itemId);
      return;
    }
    this.mediaByItemId.set(params.itemId, { ...existing, mediaUrl: params.mediaUrl });
    this.mediaItemIds.add(params.itemId);
  }

  private async recordToolOutputImages(item: JsonObject): Promise<void> {
    if (!Array.isArray(item.output)) {
      return;
    }
    const rawItemId = readString(item, "call_id") ?? readString(item, "id");
    if (!rawItemId) {
      return;
    }
    if (this.hostDynamicToolCallIds.has(rawItemId)) {
      // The host already applied media.outbound to this dynamic tool's result;
      // its raw echo must not bypass that decision as a host-owned attachment.
      return;
    }
    for (const [index, part] of item.output.entries()) {
      if (!isInputImagePart(part)) {
        continue;
      }
      const parsed = parseToolOutputImageDataUrl(part.image_url);
      if (!parsed) {
        continue;
      }
      const itemId = `${rawItemId}:image:${index}`;
      await this.recordImage({
        itemId,
        result: parsed.base64,
        requireImageBytes: true,
        source: "tool-output",
      });
      // Overlapping notifications may deliver the ImageView identity while this
      // copy materializes, so read it after the await instead of caching it.
      const sourcePath = this.sourcePathByViewedImageCallId.get(rawItemId);
      if (sourcePath) {
        this.attachViewedImageSourcePath(itemId, sourcePath);
      }
    }
  }

  private recordViewedImageSourcePath(callId: string, sourcePath: string): void {
    this.sourcePathByViewedImageCallId.set(callId, sourcePath);
    for (const itemId of this.mediaByItemId.keys()) {
      if (itemId.startsWith(`${callId}:image:`)) {
        this.attachViewedImageSourcePath(itemId, sourcePath);
      }
    }
  }

  private attachViewedImageSourcePath(itemId: string, sourcePath: string): void {
    const media = this.mediaByItemId.get(itemId);
    if (media?.mediaUrl && !media.savedPath) {
      this.mediaByItemId.set(itemId, { ...media, savedPath: sourcePath });
    }
  }
}

function isInputImagePart(value: unknown): value is { type: "input_image"; image_url: string } {
  return isJsonObject(value) && value.type === "input_image" && typeof value.image_url === "string";
}

function parseToolOutputImageDataUrl(value: string): { base64: string } | undefined {
  if (value.slice(0, 5).toLowerCase() !== "data:") {
    return undefined;
  }
  const commaIndex = value.indexOf(",", 5);
  if (commaIndex < 0 || commaIndex > MAX_TOOL_OUTPUT_IMAGE_DATA_URL_HEADER_CHARS) {
    return undefined;
  }
  const [rawMimeType, ...metadata] = value.slice(5, commaIndex).split(";");
  const mimeType = rawMimeType?.trim().toLowerCase();
  if (
    (!mimeType?.startsWith("image/") && mimeType !== "application/octet-stream") ||
    !metadata.some((entry) => entry.trim().toLowerCase() === "base64")
  ) {
    return undefined;
  }
  const base64 = value.slice(commaIndex + 1);
  return base64 ? { base64 } : undefined;
}

function imageSourceDescription(source: "native" | "raw" | "tool-output"): string {
  return source === "tool-output" ? "tool output image" : `${source} image generation result`;
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

function isBase64WhitespaceCode(code: number): boolean {
  return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d;
}
