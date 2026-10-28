import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  embeddedAgentLog,
  type EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams,
  type MessagingToolSend,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import type { AgentHarnessToolResultTelemetry } from "openclaw/plugin-sdk/agent-harness-tool-runtime";
import type { RemoteWorkspaceFileReader } from "openclaw/plugin-sdk/file-access-runtime";
import { generatedImageAssetFromBase64 } from "openclaw/plugin-sdk/image-generation";
import { resolveGeneratedMediaMaxBytes } from "openclaw/plugin-sdk/media-generation-runtime";
import { estimateBase64DecodedBytes } from "openclaw/plugin-sdk/media-runtime";
import {
  normalizeMediaReferenceForComparison,
  saveMediaBuffer,
} from "openclaw/plugin-sdk/media-store";
import { readStringField as readString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { CodexThreadItem, JsonObject } from "./protocol.js";

const GENERATED_IMAGE_MEDIA_SUBDIR = "tool-image-generation";

type GeneratedImageResult = {
  itemId: string;
  result: string;
  revisedPrompt?: string;
  source: "native" | "raw";
};

type MediaDigest = { bytes: number; sha256: string };

function digestMedia(buffer: Buffer): MediaDigest {
  return { bytes: buffer.length, sha256: createHash("sha256").update(buffer).digest("hex") };
}

function localMediaPath(sourceUrl: string): string | undefined {
  if (sourceUrl.startsWith("file:")) {
    try {
      return fileURLToPath(sourceUrl);
    } catch {
      return undefined;
    }
  }
  return path.isAbsolute(sourceUrl) ? sourceUrl : undefined;
}

export class CodexGeneratedMediaProjection {
  private readonly itemIds = new Set<string>();
  private readonly mediaByItemId = new Map<string, { mediaUrl?: string; savedPath?: string }>();
  private readonly digestByMediaUrl = new Map<string, MediaDigest>();
  private readonly copiedSourceAliases = new Map<string, string>();
  private readonly gatewayMaterializedItemIds = new Set<string>();
  private readonly pendingMaterializationsByItemId = new Map<string, Promise<void>>();

  constructor(
    private readonly config: EmbeddedRunAttemptParams["config"],
    private readonly remote?: {
      remoteWorkspaceRoot?: string;
      readFile?: RemoteWorkspaceFileReader;
      requestTimeoutMs?: number;
      signal?: AbortSignal;
    },
  ) {}

  hasGeneratedMedia(): boolean {
    return this.itemIds.size > 0;
  }

  async recordNative(item: CodexThreadItem | undefined): Promise<void> {
    if (item?.type !== "imageGeneration") {
      return;
    }
    // Image generation is already a billable side effect even if its remote
    // artifact cannot be transferred into this gateway's media store.
    this.itemIds.add(item.id);
    const savedPath = readString(item, "savedPath")?.trim();
    if (savedPath) {
      this.mediaByItemId.set(item.id, { ...this.mediaByItemId.get(item.id), savedPath });
    }
    const result = readString(item, "result");
    if (result) {
      await this.recordImage({
        itemId: item.id,
        result,
        revisedPrompt: readString(item, "revisedPrompt"),
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
          const bytes = await this.remote.readFile({
            path: savedPath,
            maxBytes: resolveGeneratedMediaMaxBytes(this.config, "image"),
            signal: this.remote.signal,
            timeoutMs: this.remote.requestTimeoutMs,
          });
          if (!bytes.length) {
            embeddedAgentLog.warn("codex remote image file returned no inline bytes", {
              itemId: item.id,
            });
            return;
          }
          await this.recordImage({
            itemId: item.id,
            result: bytes.toString("base64"),
            revisedPrompt: readString(item, "revisedPrompt"),
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
      const existing = this.mediaByItemId.get(item.id);
      if (!existing?.mediaUrl) {
        this.mediaByItemId.set(item.id, { ...existing, mediaUrl: savedPath });
      }
    }
  }

  async recordRaw(item: JsonObject): Promise<void> {
    if (readString(item, "type") !== "image_generation_call") {
      return;
    }
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
    });
  }

  private async recordImage(params: GeneratedImageResult): Promise<void> {
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
      this.pendingMaterializationsByItemId.delete(params.itemId);
    }
  }

  private async materializeImage(params: GeneratedImageResult): Promise<void> {
    const maxBytes = resolveGeneratedMediaMaxBytes(this.config, "image");
    const estimatedDecodedBytes = estimateBase64DecodedBytes(params.result);
    if (estimatedDecodedBytes > maxBytes) {
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
      // Both Codex event shapes can carry a DevBox-local savedPath; channel
      // delivery must always use the copy materialized on this gateway.
      this.mediaByItemId.set(params.itemId, {
        ...this.mediaByItemId.get(params.itemId),
        mediaUrl: saved.path,
      });
      this.digestByMediaUrl.set(saved.path, digestMedia(asset.buffer));
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

  /**
   * A model can send a byte-identical copy of a generated image from another
   * local path. Path aliases miss that copy, so confirmed sends are matched by
   * size and content hash before delivery projection. Only same-size regular
   * files are read; remote workspace paths are never resolved on this host.
   */
  async resolveCopiedMediaSources(
    deliveries: Readonly<AgentHarnessToolResultTelemetry["confirmedMediaDeliveries"]> = [],
  ): Promise<void> {
    if (this.remote?.remoteWorkspaceRoot || this.digestByMediaUrl.size === 0) {
      return;
    }
    const knownSources = new Set<string>();
    for (const { mediaUrl, savedPath } of this.mediaByItemId.values()) {
      for (const source of [mediaUrl, savedPath]) {
        if (source) {
          knownSources.add(normalizeMediaReferenceForComparison(source));
        }
      }
    }
    for (const sourceUrl of deliveries.flatMap((delivery) => delivery.sourceUrls)) {
      const key = normalizeMediaReferenceForComparison(sourceUrl);
      const filePath = localMediaPath(sourceUrl.trim());
      if (knownSources.has(key) || this.copiedSourceAliases.has(key) || !filePath) {
        continue;
      }
      try {
        const stat = await fs.lstat(filePath);
        const sameSize = [...this.digestByMediaUrl].filter(
          ([, digest]) => digest.bytes === stat.size,
        );
        if (!stat.isFile() || sameSize.length === 0) {
          continue;
        }
        const { sha256 } = digestMedia(await fs.readFile(filePath));
        const match = sameSize.find(([, digest]) => digest.sha256 === sha256);
        if (match) {
          this.copiedSourceAliases.set(key, match[0]);
        }
      } catch {
        // An unreadable or vanished copy keeps path-only matching.
      }
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
    for (const [source, mediaUrl] of this.copiedSourceAliases) {
      generatedUrlBySource.set(source, mediaUrl);
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
}
