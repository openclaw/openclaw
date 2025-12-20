import type { AgentTool, AgentToolResult } from "@mariozechner/pi-ai";
import { bashTool, codingTools, readTool } from "@mariozechner/pi-coding-agent";
import { type TSchema, Type } from "@sinclair/typebox";

import { getImageMetadata, resizeToJpeg } from "../media/image-ops.js";
import { detectMime } from "../media/mime.js";
import { startWebLoginWithQr, waitForWebLogin } from "../web/login-qr.js";

// TODO(steipete): Remove this wrapper once pi-mono ships file-magic MIME detection
// for `read` image payloads in `@mariozechner/pi-coding-agent` (then switch back to `codingTools` directly).
type ToolContentBlock = AgentToolResult<unknown>["content"][number];
type ImageContentBlock = Extract<ToolContentBlock, { type: "image" }>;
type TextContentBlock = Extract<ToolContentBlock, { type: "text" }>;

// Anthropic Messages API limitation (observed in Clawdis sessions):
// When sending many images in a single request (e.g. via session history + tool results),
// Anthropic rejects any image where *either* dimension exceeds 2000px.
//
// To keep sessions resilient (and avoid "silent" WhatsApp non-replies), we auto-downscale
// all base64 image blocks above this limit while preserving aspect ratio.
const MAX_IMAGE_DIMENSION_PX = 2000;

function sniffMimeFromBase64(base64: string): string | undefined {
  const trimmed = base64.trim();
  if (!trimmed) return undefined;

  const take = Math.min(256, trimmed.length);
  const sliceLen = take - (take % 4);
  if (sliceLen < 8) return undefined;

  try {
    const head = Buffer.from(trimmed.slice(0, sliceLen), "base64");
    return detectMime({ buffer: head });
  } catch {
    return undefined;
  }
}

function rewriteReadImageHeader(text: string, mimeType: string): string {
  // pi-coding-agent uses: "Read image file [image/png]"
  if (text.startsWith("Read image file [") && text.endsWith("]")) {
    return `Read image file [${mimeType}]`;
  }
  return text;
}

function normalizeReadImageResult(
  result: AgentToolResult<unknown>,
  filePath: string,
): AgentToolResult<unknown> {
  const content = Array.isArray(result.content) ? result.content : [];

  const image = content.find(
    (b): b is ImageContentBlock =>
      !!b &&
      typeof b === "object" &&
      (b as { type?: unknown }).type === "image" &&
      typeof (b as { data?: unknown }).data === "string" &&
      typeof (b as { mimeType?: unknown }).mimeType === "string",
  );
  if (!image) return result;

  if (!image.data.trim()) {
    throw new Error(`read: image payload is empty (${filePath})`);
  }

  const sniffed = sniffMimeFromBase64(image.data);
  if (!sniffed) return result;

  if (!sniffed.startsWith("image/")) {
    throw new Error(
      `read: file looks like ${sniffed} but was treated as ${image.mimeType} (${filePath})`,
    );
  }

  if (sniffed === image.mimeType) return result;

  const nextContent = content.map((block) => {
    if (
      block &&
      typeof block === "object" &&
      (block as { type?: unknown }).type === "image"
    ) {
      const b = block as ImageContentBlock & { mimeType: string };
      return { ...b, mimeType: sniffed } satisfies ImageContentBlock;
    }
    if (
      block &&
      typeof block === "object" &&
      (block as { type?: unknown }).type === "text" &&
      typeof (block as { text?: unknown }).text === "string"
    ) {
      const b = block as TextContentBlock & { text: string };
      return {
        ...b,
        text: rewriteReadImageHeader(b.text, sniffed),
      } satisfies TextContentBlock;
    }
    return block;
  });

  return { ...result, content: nextContent };
}

type AnyAgentTool = AgentTool<TSchema, unknown>;

function createWhatsAppLoginTool(): AnyAgentTool {
  return {
    label: "WhatsApp Login",
    name: "whatsapp_login",
    description:
      "Generate a WhatsApp QR code for linking, or wait for the scan to complete.",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("start"), Type.Literal("wait")]),
      timeoutMs: Type.Optional(Type.Number()),
      force: Type.Optional(Type.Boolean()),
    }),
    execute: async (_toolCallId, args) => {
      const action = (args as { action?: string })?.action ?? "start";
      if (action === "wait") {
        const result = await waitForWebLogin({
          timeoutMs:
            typeof (args as { timeoutMs?: unknown }).timeoutMs === "number"
              ? (args as { timeoutMs?: number }).timeoutMs
              : undefined,
        });
        return {
          content: [{ type: "text", text: result.message }],
          details: { connected: result.connected },
        };
      }

      const result = await startWebLoginWithQr({
        timeoutMs:
          typeof (args as { timeoutMs?: unknown }).timeoutMs === "number"
            ? (args as { timeoutMs?: number }).timeoutMs
            : undefined,
        force:
          typeof (args as { force?: unknown }).force === "boolean"
            ? (args as { force?: boolean }).force
            : false,
      });

      if (!result.qrDataUrl) {
        return {
          content: [
            {
              type: "text",
              text: result.message,
            },
          ],
          details: { qr: false },
        };
      }

      const text = [
        result.message,
        "",
        "Open WhatsApp → Linked Devices and scan:",
        "",
        `![whatsapp-qr](${result.qrDataUrl})`,
      ].join("\n");
      return {
        content: [{ type: "text", text }],
        details: { qr: true },
      };
    },
  };
}

function isImageBlock(block: unknown): block is ImageContentBlock {
  if (!block || typeof block !== "object") return false;
  const rec = block as Record<string, unknown>;
  return (
    rec.type === "image" &&
    typeof rec.data === "string" &&
    typeof rec.mimeType === "string"
  );
}

function isTextBlock(block: unknown): block is TextContentBlock {
  if (!block || typeof block !== "object") return false;
  const rec = block as Record<string, unknown>;
  return rec.type === "text" && typeof rec.text === "string";
}

async function resizeImageBase64IfNeeded(params: {
  base64: string;
  mimeType: string;
  maxDimensionPx: number;
}): Promise<{ base64: string; mimeType: string; resized: boolean }> {
  const buf = Buffer.from(params.base64, "base64");
  const meta = await getImageMetadata(buf);
  const width = meta?.width;
  const height = meta?.height;
  if (
    typeof width !== "number" ||
    typeof height !== "number" ||
    (width <= params.maxDimensionPx && height <= params.maxDimensionPx)
  ) {
    return { base64: params.base64, mimeType: params.mimeType, resized: false };
  }

  const mime = params.mimeType.toLowerCase();
  let out: Buffer;
  try {
    const mod = (await import("sharp")) as unknown as {
      default?: typeof import("sharp");
    };
    const sharp = mod.default ?? (mod as unknown as typeof import("sharp"));
    const img = sharp(buf, { failOnError: false }).resize({
      width: params.maxDimensionPx,
      height: params.maxDimensionPx,
      fit: "inside",
      withoutEnlargement: true,
    });
    if (mime === "image/jpeg" || mime === "image/jpg") {
      out = await img.jpeg({ quality: 85 }).toBuffer();
    } else if (mime === "image/webp") {
      out = await img.webp({ quality: 85 }).toBuffer();
    } else if (mime === "image/png") {
      out = await img.png().toBuffer();
    } else {
      out = await img.png().toBuffer();
    }
  } catch {
    // Bun can't load sharp native addons. Fall back to a JPEG conversion.
    out = await resizeToJpeg({
      buffer: buf,
      maxSide: params.maxDimensionPx,
      quality: 85,
      withoutEnlargement: true,
    });
  }

  const sniffed = detectMime({ buffer: out.slice(0, 256) });
  const nextMime = sniffed?.startsWith("image/") ? sniffed : params.mimeType;

  return { base64: out.toString("base64"), mimeType: nextMime, resized: true };
}

export async function sanitizeContentBlocksImages(
  blocks: ToolContentBlock[],
  label: string,
  opts: { maxDimensionPx?: number } = {},
): Promise<ToolContentBlock[]> {
  const maxDimensionPx = Math.max(
    opts.maxDimensionPx ?? MAX_IMAGE_DIMENSION_PX,
    1,
  );
  const out: ToolContentBlock[] = [];

  for (const block of blocks) {
    if (!isImageBlock(block)) {
      out.push(block);
      continue;
    }

    const data = block.data.trim();
    if (!data) {
      out.push({
        type: "text",
        text: `[${label}] omitted empty image payload`,
      } satisfies TextContentBlock);
      continue;
    }

    try {
      const resized = await resizeImageBase64IfNeeded({
        base64: data,
        mimeType: block.mimeType,
        maxDimensionPx,
      });
      out.push({ ...block, data: resized.base64, mimeType: resized.mimeType });
    } catch (err) {
      out.push({
        type: "text",
        text: `[${label}] omitted image payload: ${String(err)}`,
      } satisfies TextContentBlock);
    }
  }

  return out;
}

export async function sanitizeToolResultImages(
  result: AgentToolResult<unknown>,
  label: string,
  opts: { maxDimensionPx?: number } = {},
): Promise<AgentToolResult<unknown>> {
  const content = Array.isArray(result.content) ? result.content : [];
  if (!content.some((b) => isImageBlock(b) || isTextBlock(b))) return result;

  const next = await sanitizeContentBlocksImages(content, label, opts);
  return { ...result, content: next };
}

function createClawdisReadTool(base: AnyAgentTool): AnyAgentTool {
  return {
    ...base,
    execute: async (toolCallId, params, signal) => {
      const result = (await base.execute(
        toolCallId,
        params,
        signal,
      )) as AgentToolResult<unknown>;
      const record =
        params && typeof params === "object"
          ? (params as Record<string, unknown>)
          : undefined;
      const filePath =
        typeof record?.path === "string" ? String(record.path) : "<unknown>";
      const normalized = normalizeReadImageResult(result, filePath);
      return sanitizeToolResultImages(normalized, `read:${filePath}`);
    },
  };
}

function createClawdisBashTool(base: AnyAgentTool): AnyAgentTool {
  return {
    ...base,
    execute: async (toolCallId, params, signal) => {
      const result = (await base.execute(
        toolCallId,
        params,
        signal,
      )) as AgentToolResult<unknown>;
      return sanitizeToolResultImages(result, "bash");
    },
  };
}

export function createClawdisCodingTools(): AnyAgentTool[] {
  const base = (codingTools as unknown as AnyAgentTool[]).map((tool) =>
    tool.name === readTool.name
      ? createClawdisReadTool(tool)
      : tool.name === bashTool.name
        ? createClawdisBashTool(tool)
        : (tool as AnyAgentTool),
  );
  return [...base, createWhatsAppLoginTool()];
}
