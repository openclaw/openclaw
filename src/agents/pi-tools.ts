import type { AgentTool, AgentToolResult } from "@mariozechner/pi-ai";
import { bashTool, codingTools, readTool } from "@mariozechner/pi-coding-agent";
import { type TSchema, Type } from "@sinclair/typebox";

import { detectMime } from "../media/mime.js";
import { startWebLoginWithQr, waitForWebLogin } from "../web/login-qr.js";
import { createClawdisTools } from "./clawdis-tools.js";
import { sanitizeToolResultImages } from "./tool-images.js";

// TODO(steipete): Remove this wrapper once pi-mono ships file-magic MIME detection
// for `read` image payloads in `@mariozechner/pi-coding-agent` (then switch back to `codingTools` directly).
type ToolContentBlock = AgentToolResult<unknown>["content"][number];
type ImageContentBlock = Extract<ToolContentBlock, { type: "image" }>;
type TextContentBlock = Extract<ToolContentBlock, { type: "text" }>;

async function sniffMimeFromBase64(
  base64: string,
): Promise<string | undefined> {
  const trimmed = base64.trim();
  if (!trimmed) return undefined;

  const take = Math.min(256, trimmed.length);
  const sliceLen = take - (take % 4);
  if (sliceLen < 8) return undefined;

  try {
    const head = Buffer.from(trimmed.slice(0, sliceLen), "base64");
    return await detectMime({ buffer: head });
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

async function normalizeReadImageResult(
  result: AgentToolResult<unknown>,
  filePath: string,
): Promise<AgentToolResult<unknown>> {
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

  const sniffed = await sniffMimeFromBase64(image.data);
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

function normalizeToolParameters(tool: AnyAgentTool): AnyAgentTool {
  const schema =
    tool.parameters && typeof tool.parameters === "object"
      ? (tool.parameters as Record<string, unknown>)
      : undefined;
  if (!schema) return tool;
  if ("type" in schema && "properties" in schema) return tool;
  if (!Array.isArray(schema.anyOf)) return tool;
  return {
    ...tool,
    parameters: {
      ...schema,
      type: "object",
      properties: schema.properties ?? {},
      additionalProperties:
        "additionalProperties" in schema ? schema.additionalProperties : true,
    } as TSchema,
  };
}

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
      const normalized = await normalizeReadImageResult(result, filePath);
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
  return [...base, createWhatsAppLoginTool(), ...createClawdisTools()].map(
    normalizeToolParameters,
  );
}
