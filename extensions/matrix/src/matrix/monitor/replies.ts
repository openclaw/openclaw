import type { MatrixClient } from "@vector-im/matrix-bot-sdk";
import type { MarkdownTableMode, ReplyPayload, RuntimeEnv } from "openclaw/plugin-sdk";
import { getMatrixRuntime } from "../../runtime.js";
import { sendMessageMatrix } from "../send.js";
import { writeFile, mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export async function deliverMatrixReplies(params: {
  replies: ReplyPayload[];
  roomId: string;
  client: MatrixClient;
  runtime: RuntimeEnv;
  textLimit: number;
  replyToMode: "off" | "first" | "all";
  threadId?: string;
  accountId?: string;
  tableMode?: MarkdownTableMode;
}): Promise<void> {
  const core = getMatrixRuntime();
  const cfg = core.config.loadConfig();
  const tableMode =
    params.tableMode ??
    core.channel.text.resolveMarkdownTableMode({
      cfg,
      channel: "matrix",
      accountId: params.accountId,
    });
  const logVerbose = (message: string) => {
    if (core.logging.shouldLogVerbose()) {
      params.runtime.log?.(message);
    }
  };
  const chunkLimit = Math.min(params.textLimit, 4000);
  const chunkMode = core.channel.text.resolveChunkMode(cfg, "matrix", params.accountId);
  let hasReplied = false;
  let tempDir: string | undefined;
  try {
    for (const reply of params.replies) {
      const contentBlocks = (reply as unknown as { content?: ContentBlock[] }).content;
      const imageBlocks: { data: string; mimeType: string }[] = [];
      let textFromContent = "";
      if (contentBlocks && Array.isArray(contentBlocks)) {
        for (const block of contentBlocks) {
          if (block.type === "image" && "data" in block) imageBlocks.push(block);
          else if (block.type === "text" && "text" in block) textFromContent += block.text + "\n";
        }
      }
      const rawText = reply.text || textFromContent || "";
      const hasMedia =
        Boolean(reply?.mediaUrl) || (reply?.mediaUrls?.length ?? 0) > 0 || imageBlocks.length > 0;
      if (!rawText.trim() && !hasMedia) {
        if (reply?.audioAsVoice) {
          logVerbose("matrix reply has audioAsVoice without media/text; skipping");
          continue;
        }
        params.runtime.error?.("matrix reply missing text/media");
        continue;
      }
      const replyToIdRaw = reply.replyToId?.trim();
      const replyToId = params.threadId || params.replyToMode === "off" ? undefined : replyToIdRaw;
      const text = core.channel.text.convertMarkdownTables(rawText, tableMode);
      const mediaList = reply.mediaUrls?.length
        ? [...reply.mediaUrls]
        : reply.mediaUrl
          ? [reply.mediaUrl]
          : [];
      if (imageBlocks.length > 0) {
        if (!tempDir) tempDir = await mkdtemp(join(tmpdir(), "openclaw-matrix-"));
        for (let i = 0; i < imageBlocks.length; i++) {
          const block = imageBlocks[i];
          const ext = block.mimeType?.split("/")[1] || "bin";
          const tempFile = join(tempDir, `image-${Date.now()}-${i}.${ext}`);
          await writeFile(tempFile, Buffer.from(block.data, "base64"));
          mediaList.push(`file://${tempFile}`);
        }
      }

      const shouldIncludeReply = (id?: string) =>
        Boolean(id) && (params.replyToMode === "all" || !hasReplied);
      const replyToIdForReply = shouldIncludeReply(replyToId) ? replyToId : undefined;

      if (mediaList.length === 0) {
        let sentTextChunk = false;
        for (const chunk of core.channel.text.chunkMarkdownTextWithMode(
          text,
          chunkLimit,
          chunkMode,
        )) {
          const trimmed = chunk.trim();
          if (!trimmed) {
            continue;
          }
          await sendMessageMatrix(params.roomId, trimmed, {
            client: params.client,
            replyToId: replyToIdForReply,
            threadId: params.threadId,
            accountId: params.accountId,
          });
          sentTextChunk = true;
        }
        if (replyToIdForReply && !hasReplied && sentTextChunk) {
          hasReplied = true;
        }
        continue;
      }

      let first = true;
      for (const mediaUrl of mediaList) {
        const caption = first ? text : "";
        await sendMessageMatrix(params.roomId, caption, {
          client: params.client,
          mediaUrl,
          replyToId: replyToIdForReply,
          threadId: params.threadId,
          audioAsVoice: reply.audioAsVoice,
          accountId: params.accountId,
        });
        first = false;
      }
      if (replyToIdForReply && !hasReplied) {
        hasReplied = true;
      }
    }
  } finally {
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
  }
}
