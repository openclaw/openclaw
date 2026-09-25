import {
  embeddedAgentLog,
  type EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams,
  type MessagingToolSend,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  generatedImageAssetFromBase64,
  parseImageDataUrl,
} from "openclaw/plugin-sdk/image-generation";
import { resolveGeneratedMediaMaxBytes } from "openclaw/plugin-sdk/media-generation-runtime";
import {
  normalizeMediaReferenceForComparison,
  saveMediaBuffer,
} from "openclaw/plugin-sdk/media-store";
import { readStringField as readString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { CodexConfirmedMediaDelivery } from "./dynamic-tools.js";
import { readItemString } from "./event-projector-values.js";
import { sanitizeInlineImageDataUrl } from "./image-payload-sanitizer.js";
import { isJsonObject, type CodexThreadItem, type JsonObject } from "./protocol.js";
import type { CodexRemoteWorkspaceFileReader } from "./remote-workspace-media.js";

const GENERATED_IMAGE_MEDIA_SUBDIR = "tool-image-generation";

interface RecordImageParams {
  itemId: string;
  result: string;
  revisedPrompt?: string;
  source: "native" | "raw";
  // True for actual image-generation results (billable/replay-unsafe side
  // effect); false for images projected out of a tool-output attachment
  // (e.g. a screenshot), which are delivery media only.
  isGeneratedSideEffect: boolean;
}

export class CodexGeneratedMediaProjection {
  private readonly itemIds = new Set<string>();
  // Only actual image-generation identities (native `imageGeneration` items and
  // raw `image_generation_call` events) count toward billing/replay-safety.
  // Projected tool-output attachments (e.g. a screenshot handed back by a
  // native tool) are delivery media, not a generation side effect, and must
  // stay out of this set.
  private readonly generatedSideEffectItemIds = new Set<string>();
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
    return this.generatedSideEffectItemIds.size > 0;
  }

  async recordNative(item: CodexThreadItem | undefined): Promise<void> {
    if (item?.type !== "imageGeneration") {
      return;
    }
    // Image generation is already a billable side effect even if its remote
    // artifact cannot be transferred into this gateway's media store.
    this.itemIds.add(item.id);
    this.generatedSideEffectItemIds.add(item.id);
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
        isGeneratedSideEffect: true,
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
            isGeneratedSideEffect: true,
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
    if (type === "image_generation_call") {
      const result = readString(item, "result");
      if (!result) {
        return;
      }
      const itemId = readString(item, "id") ?? `raw-image-${this.itemIds.size}`;
      await this.recordImage({
        itemId,
        result,
        revisedPrompt: readString(item, "revised_prompt") ?? readString(item, "revisedPrompt"),
        source: "raw",
        isGeneratedSideEffect: true,
      });
      return;
    }
    if (type === "function_call_output" || type === "custom_tool_call_output") {
      await this.recordRawToolOutputImages(item);
    }
  }

  // Native tool results (e.g. Codex's ImageView) surface here as a raw
  // function/custom tool-output item whose output array carries nested
  // input_image entries; readCodexResponseOutput deliberately leaves those
  // bytes to this media owner instead of copying them into the text transcript.
  private async recordRawToolOutputImages(item: JsonObject): Promise<void> {
    if (!Array.isArray(item.output)) {
      return;
    }
    const baseItemId =
      readString(item, "id") ??
      readString(item, "call_id") ??
      `raw-tool-output-${this.itemIds.size}`;
    let index = 0;
    for (const part of item.output) {
      if (!isJsonObject(part) || readString(part, "type") !== "input_image") {
        continue;
      }
      const rawImageUrl = readString(part, "image_url");
      const sanitizedImageUrl = rawImageUrl ? sanitizeInlineImageDataUrl(rawImageUrl) : undefined;
      const parsed = sanitizedImageUrl ? parseImageDataUrl(sanitizedImageUrl) : undefined;
      if (!parsed) {
        continue;
      }
      await this.recordImage({
        itemId: `${baseItemId}-image-${index}`,
        result: parsed.base64,
        source: "raw",
        // A projected tool-output attachment (e.g. a screenshot) is delivery
        // media, not a billable/replay-unsafe generation side effect.
        isGeneratedSideEffect: false,
      });
      index += 1;
    }
  }

  private async recordImage(params: RecordImageParams): Promise<void> {
    this.itemIds.add(params.itemId);
    if (params.isGeneratedSideEffect) {
      this.generatedSideEffectItemIds.add(params.itemId);
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

  private async materializeImage(params: RecordImageParams): Promise<void> {
    const maxBytes = resolveGeneratedMediaMaxBytes(this.config, "image");
    const estimatedDecodedBytes = estimateBase64DecodedBytes(params.result);
    if (estimatedDecodedBytes !== undefined && estimatedDecodedBytes > maxBytes) {
      embeddedAgentLog.warn(
        `codex app-server ${params.source} image generation result exceeds media limit`,
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
      revisedPrompt: params.revisedPrompt,
      fileNamePrefix: "codex-image-generation",
      sniffMimeType: true,
    });
    if (!asset) {
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
        `codex app-server ${params.source} image generation result save failed`,
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

function isBase64WhitespaceCode(code: number): boolean {
  return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d;
}
