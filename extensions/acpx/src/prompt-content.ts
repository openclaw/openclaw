import type { ContentBlock } from "@agentclientprotocol/sdk";

export type PromptInput = ContentBlock[];

export class PromptInputValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PromptInputValidationError";
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isBase64Data(value: string): boolean {
  if (value.length === 0 || value.length % 4 !== 0) {
    return false;
  }
  return /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value);
}

function isImageMimeType(value: string): boolean {
  return /^image\/[A-Za-z0-9.+-]+$/i.test(value);
}

function isTextBlock(value: unknown): value is Extract<ContentBlock, { type: "text" }> {
  const record = asRecord(value);
  return record?.type === "text" && typeof record.text === "string";
}

function isImageBlock(value: unknown): value is Extract<ContentBlock, { type: "image" }> {
  const record = asRecord(value);
  return (
    record?.type === "image" &&
    isNonEmptyString(record.mimeType) &&
    isImageMimeType(record.mimeType) &&
    typeof record.data === "string" &&
    isBase64Data(record.data)
  );
}

function isResourceLinkBlock(
  value: unknown,
): value is Extract<ContentBlock, { type: "resource_link" }> {
  const record = asRecord(value);
  return (
    record?.type === "resource_link" &&
    isNonEmptyString(record.uri) &&
    (record.title === undefined || typeof record.title === "string") &&
    (record.name === undefined || typeof record.name === "string")
  );
}

function isResourcePayload(value: unknown): boolean {
  const record = asRecord(value);
  if (!record || !isNonEmptyString(record.uri)) {
    return false;
  }
  return record.text === undefined || typeof record.text === "string";
}

function isResourceBlock(value: unknown): value is Extract<ContentBlock, { type: "resource" }> {
  const record = asRecord(value);
  return record?.type === "resource" && isResourcePayload(record.resource);
}

function isContentBlock(value: unknown): value is ContentBlock {
  return (
    isTextBlock(value) ||
    isImageBlock(value) ||
    isResourceLinkBlock(value) ||
    isResourceBlock(value)
  );
}

function getContentBlockValidationError(value: unknown, index: number): string | undefined {
  const record = asRecord(value);
  if (!record || typeof record.type !== "string") {
    return `prompt[${index}] must be an ACP content block object`;
  }

  switch (record.type) {
    case "text":
      return typeof record.text === "string"
        ? undefined
        : `prompt[${index}] text block must include a string text field`;
    case "image":
      if (!isNonEmptyString(record.mimeType)) {
        return `prompt[${index}] image block must include a non-empty mimeType`;
      }
      if (!isImageMimeType(record.mimeType)) {
        return `prompt[${index}] image block mimeType must start with image/`;
      }
      if (typeof record.data !== "string" || record.data.length === 0) {
        return `prompt[${index}] image block must include non-empty base64 data`;
      }
      if (!isBase64Data(record.data)) {
        return `prompt[${index}] image block data must be valid base64`;
      }
      return undefined;
    case "resource_link":
      if (!isNonEmptyString(record.uri)) {
        return `prompt[${index}] resource_link block must include a non-empty uri`;
      }
      if (record.title !== undefined && typeof record.title !== "string") {
        return `prompt[${index}] resource_link block title must be a string when present`;
      }
      if (record.name !== undefined && typeof record.name !== "string") {
        return `prompt[${index}] resource_link block name must be a string when present`;
      }
      return undefined;
    case "resource":
      if (!asRecord(record.resource)) {
        return `prompt[${index}] resource block must include a resource object`;
      }
      if (!isResourcePayload(record.resource)) {
        return `prompt[${index}] resource block resource must include a non-empty uri and optional text`;
      }
      return undefined;
    default:
      return `prompt[${index}] has unsupported content block type ${JSON.stringify(record.type)}`;
  }
}

export function isPromptInput(value: unknown): value is PromptInput {
  return Array.isArray(value) && value.every((entry) => isContentBlock(entry));
}

export function textPrompt(text: string): PromptInput {
  return [
    {
      type: "text",
      text,
    },
  ];
}

function parseStructuredPrompt(source: string): PromptInput | undefined {
  if (!source.startsWith("[")) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(source) as unknown;
    if (isPromptInput(parsed)) {
      return parsed;
    }
    if (Array.isArray(parsed)) {
      const detail =
        parsed
          .map((entry, index) => getContentBlockValidationError(entry, index))
          .find((message) => message !== undefined) ??
        "Structured prompt JSON must be an array of valid ACP content blocks";
      throw new PromptInputValidationError(detail);
    }
    return undefined;
  } catch (error) {
    if (error instanceof PromptInputValidationError) {
      throw error;
    }
    return undefined;
  }
}

export function parsePromptSource(source: string): PromptInput {
  const trimmed = source.trim();
  const structured = parseStructuredPrompt(trimmed);
  if (structured) {
    return structured;
  }
  if (!trimmed) {
    return [];
  }
  return textPrompt(trimmed);
}

export function mergePromptSourceWithText(source: string, suffixText: string): PromptInput {
  const prompt = parsePromptSource(source);
  const appended = suffixText.trim();
  if (!appended) {
    return prompt;
  }
  if (prompt.length === 0) {
    return textPrompt(appended);
  }
  return [...prompt, ...textPrompt(appended)];
}

export function promptToDisplayText(prompt: PromptInput): string {
  return prompt
    .map((block) => {
      switch (block.type) {
        case "text":
          return block.text;
        case "resource_link":
          return block.title ?? block.name ?? block.uri;
        case "resource":
          return "text" in block.resource && typeof block.resource.text === "string"
            ? block.resource.text
            : block.resource.uri;
        case "image":
          return `[image] ${block.mimeType}`;
        default:
          return "";
      }
    })
    .filter((entry) => entry.trim().length > 0)
    .join("\n\n")
    .trim();
}
