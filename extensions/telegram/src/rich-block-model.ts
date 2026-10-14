// OpenClaw-authored rich block subset plus size accounting and the plain-text
// projection shared by the emitter, splitter, and fallback paths.
import type { User } from "grammy/types";

export type TelegramRichBlocksDegradationReason = "list-limit" | "table-ascii" | "nesting-limit";

export type RichText =
  | string
  | RichText[]
  | {
      type:
        | "bold"
        | "italic"
        | "underline"
        | "strikethrough"
        | "code"
        | "spoiler"
        | "marked"
        | "subscript"
        | "superscript";
      text: RichText;
    }
  | {
      type: "url";
      text: RichText;
      url: string;
    }
  | {
      type: "text_mention";
      text: RichText;
      user: User;
    }
  | {
      type: "anchor_link";
      text: RichText;
      anchor_name: string;
    }
  | {
      type: "mathematical_expression";
      expression: string;
    }
  | {
      type: "custom_emoji";
      custom_emoji_id: string;
      alternative_text: string;
    };

type RichBlockTableCellAlign = "left" | "center" | "right";

export type RichBlockTableCell = {
  text?: RichText;
  is_header?: true;
  colspan?: number;
  rowspan?: number;
  align: RichBlockTableCellAlign;
  valign: "top" | "middle" | "bottom";
};

export type InputRichBlockParagraph = {
  type: "paragraph";
  text: RichText;
};

type InputRichBlockHeading = {
  type: "heading";
  text: RichText;
  size: 1 | 2 | 3 | 4 | 5 | 6;
};

type InputRichBlockPre = {
  type: "pre";
  text: string;
  language?: string;
};

type InputRichBlockBlockquote = {
  type: "blockquote";
  blocks: InputRichBlock[];
  credit?: RichText;
};

type InputRichBlockTable = {
  type: "table";
  cells: RichBlockTableCell[][];
  is_bordered?: true;
  is_striped?: true;
  caption?: RichText;
};

export type RichBlockCaption = {
  text: RichText;
  credit?: RichText;
};

export type InputRichBlockListItem = {
  blocks: InputRichBlock[];
  has_checkbox?: true;
  is_checked?: true;
  value?: number;
  type?: "a" | "A" | "i" | "I" | "1";
};

type InputMediaUrl<K extends string> = { type: K; media: string };

export type InputRichBlock =
  | InputRichBlockParagraph
  | InputRichBlockHeading
  | InputRichBlockPre
  | InputRichBlockBlockquote
  | InputRichBlockTable
  | { type: "divider" }
  | { type: "anchor"; name: string }
  | { type: "footer"; text: RichText }
  | { type: "pullquote"; text: RichText; credit?: RichText }
  | { type: "mathematical_expression"; expression: string }
  | { type: "details"; summary: RichText; blocks: InputRichBlock[]; is_open?: true }
  | { type: "list"; items: InputRichBlockListItem[] }
  | { type: "photo"; photo: InputMediaUrl<"photo">; caption?: RichBlockCaption }
  | { type: "video"; video: InputMediaUrl<"video">; caption?: RichBlockCaption }
  | { type: "audio"; audio: InputMediaUrl<"audio">; caption?: RichBlockCaption }
  | { type: "animation"; animation: InputMediaUrl<"animation">; caption?: RichBlockCaption }
  | { type: "voice_note"; voice_note: InputMediaUrl<"voice_note">; caption?: RichBlockCaption }
  | { type: "collage"; blocks: InputRichBlock[]; caption?: RichBlockCaption }
  | { type: "slideshow"; blocks: InputRichBlock[]; caption?: RichBlockCaption }
  | {
      type: "map";
      location: { latitude: number; longitude: number };
      zoom: number;
      width: number;
      height: number;
      caption?: RichBlockCaption;
    };

const TELEGRAM_USER_MENTION_HREF_RE = /^tg:\/\/user\?id=(\d+)$/i;

// Telegram HTML turns tg://user?id= links into mentions server-side; rich
// blocks are already structured, so the mention has to be explicit here.
// Only the ID comes from the link; is_bot and first_name fill the wire type.
export function richTextLink(text: RichText, url: string): RichText {
  const id = Number(TELEGRAM_USER_MENTION_HREF_RE.exec(url)?.[1]);
  return Number.isSafeInteger(id)
    ? { type: "text_mention", text, user: { id, is_bot: false, first_name: "" } }
    : { type: "url", text, url };
}

export function normalizeRichText(value: RichText, depth = 0): RichText {
  if (depth >= MAX_RICH_BLOCK_NESTING) {
    return richTextToPlainString(value);
  }
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    const flattened: RichText[] = [];
    for (const item of value) {
      const normalized = normalizeRichText(item, depth + 1);
      if (Array.isArray(normalized)) {
        flattened.push(...normalized);
      } else if (normalized !== "") {
        flattened.push(normalized);
      }
    }
    return flattened.length <= 1 ? (flattened[0] ?? "") : flattened;
  }
  if (value.type === "mathematical_expression" || value.type === "custom_emoji") {
    return value;
  }
  return { ...value, text: normalizeRichText(value.text, depth + 1) };
}

export function countRichTextChars(text: RichText): number {
  const size = { chars: 0, blocks: 0, media: 0, nesting: 0 };
  measureRichBlockText(text, size, 0);
  return size.chars;
}

type RichBlockMeasurement = { chars: number; blocks: number; media: number; nesting: number };
// Telegram accepts 15 nested containers plus the leaf, but rejects 16 containers.
export const MAX_RICH_BLOCK_NESTING = 15;

function measureRichBlockText(text: RichText, size: RichBlockMeasurement, depth: number): void {
  const pending = [{ text, depth }];
  while (pending.length > 0) {
    const frame = pending.pop()!;
    const value = frame.text;
    if (typeof value === "string") {
      size.chars += value.length;
    } else if (Array.isArray(value)) {
      for (const part of value) {
        pending.push({ text: part, depth: frame.depth });
      }
    } else if (value.type === "mathematical_expression") {
      size.chars += value.expression.length;
    } else if (value.type === "custom_emoji") {
      size.chars += value.alternative_text.length;
    } else {
      size.nesting = Math.max(size.nesting, frame.depth + 1);
      pending.push({ text: value.text, depth: frame.depth + 1 });
    }
  }
}

function measureRichBlockCaption(
  caption: RichBlockCaption | undefined,
  size: RichBlockMeasurement,
  depth: number,
): void {
  if (caption) {
    size.nesting = Math.max(size.nesting, depth);
    measureRichBlockText(caption.text, size, depth);
    if (caption.credit) {
      measureRichBlockText(caption.credit, size, depth);
    }
  }
}

/** Bot API budgets: UTF-16 text, nested blocks/items/rows, media, and formatting edges. */
export function measureInputRichBlocks(blocks: readonly InputRichBlock[]) {
  const size = { chars: 0, blocks: 0, media: 0, nesting: 0 };
  const pending = [{ children: blocks, depth: 0 }];
  while (pending.length > 0) {
    const { children, depth } = pending.pop()!;
    // Empty containers still contribute their nesting edge; plain text leaves do not add one.
    size.nesting = Math.max(size.nesting, depth);
    for (const block of children) {
      size.blocks += 1;
      switch (block.type) {
        case "paragraph":
        case "heading":
        case "footer":
        case "pre":
          measureRichBlockText(block.text, size, depth);
          break;
        case "mathematical_expression":
          size.chars += block.expression.length;
          break;
        case "pullquote":
          measureRichBlockCaption(block, size, depth);
          break;
        case "blockquote":
          pending.push({ children: block.blocks, depth: depth + 1 });
          if (block.credit) {
            measureRichBlockText(block.credit, size, depth + 1);
          }
          break;
        case "details":
          pending.push({ children: block.blocks, depth: depth + 1 });
          measureRichBlockText(block.summary, size, depth + 1);
          break;
        case "collage":
        case "slideshow":
          pending.push({ children: block.blocks, depth: depth + 1 });
          measureRichBlockCaption(block.caption, size, depth + 1);
          break;
        case "list":
          size.blocks += block.items.length;
          size.nesting = Math.max(size.nesting, depth + 1);
          for (const item of block.items) {
            pending.push({ children: item.blocks, depth: depth + 1 });
          }
          break;
        case "table":
          size.blocks += block.cells.length;
          size.nesting = Math.max(size.nesting, depth + 1);
          if (block.caption) {
            measureRichBlockText(block.caption, size, depth + 1);
          }
          for (const row of block.cells) {
            for (const cell of row) {
              const text = cell.text;
              if (text) {
                measureRichBlockText(text, size, depth + 1);
              }
            }
          }
          break;
        case "photo":
        case "video":
        case "audio":
        case "animation":
        case "voice_note":
          size.media += 1;
          measureRichBlockCaption(block.caption, size, depth + 1);
          break;
        case "map":
          // Live-verified: maps do not consume the 50-attachment budget.
          measureRichBlockCaption(block.caption, size, depth + 1);
          break;
        case "anchor":
        case "divider":
          break;
      }
    }
  }
  return size;
}

export function richTextToPlainString(text: RichText): string {
  const parts: string[] = [];
  const pending = [text];
  while (pending.length > 0) {
    const node = pending.pop()!;
    if (typeof node === "string") {
      parts.push(node);
    } else if (Array.isArray(node)) {
      for (let index = node.length - 1; index >= 0; index -= 1) {
        pending.push(node[index]!);
      }
    } else if (node.type === "mathematical_expression") {
      parts.push(node.expression);
    } else if (node.type === "custom_emoji") {
      parts.push(node.alternative_text);
    } else {
      pending.push(node.text);
    }
  }
  return parts.join("");
}

function richTextWithCreditToPlainText(caption: RichBlockCaption): string {
  const credit = caption.credit ? ` — ${richTextToPlainString(caption.credit)}` : "";
  return `${richTextToPlainString(caption.text)}${credit}`;
}

function captionToPlainText(caption: RichBlockCaption | undefined): string {
  return caption ? richTextWithCreditToPlainText(caption).trim() : "";
}

export function inputRichBlocksToPlainText(blocks: readonly InputRichBlock[]): string {
  type Frame = {
    blocks: readonly InputRichBlock[];
    index: number;
    listDepth: number;
    parts: string[];
    finish: (text: string) => void;
  };
  let result = "";
  const pending: Frame[] = [];
  const visit = (
    children: readonly InputRichBlock[],
    listDepth: number,
    finish: Frame["finish"],
  ) => {
    pending.push({ blocks: children, index: 0, listDepth, parts: [], finish });
  };
  visit(blocks, 0, (text) => {
    result = text;
  });
  while (pending.length > 0) {
    const frame = pending[pending.length - 1]!;
    if (frame.index === frame.blocks.length) {
      pending.pop();
      frame.finish(frame.parts.join("\n"));
      continue;
    }
    const { listDepth } = frame;
    const push = (value: string) => {
      if (value) {
        frame.parts.push(value);
      }
    };
    const block = frame.blocks[frame.index++]!;
    switch (block.type) {
      case "paragraph":
      case "heading":
      case "footer":
      case "pre":
        push(richTextToPlainString(block.text));
        break;
      case "mathematical_expression":
        push(block.expression);
        break;
      case "pullquote":
        push(richTextWithCreditToPlainText(block));
        break;
      case "blockquote":
        visit(block.blocks, listDepth, (text) => {
          push(text);
          if (block.credit) {
            push(`— ${richTextToPlainString(block.credit)}`);
          }
        });
        break;
      case "collage":
      case "slideshow":
        visit(block.blocks, listDepth, (text) => {
          push(text);
          push(captionToPlainText(block.caption));
        });
        break;
      case "details":
        push(richTextToPlainString(block.summary));
        visit(block.blocks, listDepth, push);
        break;
      case "list":
        for (let index = block.items.length - 1; index >= 0; index -= 1) {
          const item = block.items[index]!;
          const markerText = item.has_checkbox
            ? item.is_checked
              ? "[x] "
              : "[ ] "
            : item.value !== undefined
              ? `${item.value}. `
              : "• ";
          const marker = `${"  ".repeat(listDepth)}${markerText}`;
          visit(item.blocks, listDepth + 1, (text) => push(`${marker}${text}`));
        }
        break;
      case "table":
        if (block.caption !== undefined) {
          push(richTextToPlainString(block.caption));
        }
        for (const row of block.cells) {
          push(row.map((cell) => richTextToPlainString(cell.text ?? "")).join(" | "));
        }
        break;
      // Fallback text keeps BOTH caption and source so a degraded delivery
      // still lets the user reach the media.
      case "photo":
        push(`${captionToPlainText(block.caption)} ${block.photo.media}`.trim());
        break;
      case "video":
        push(`${captionToPlainText(block.caption)} ${block.video.media}`.trim());
        break;
      case "audio":
        push(`${captionToPlainText(block.caption)} ${block.audio.media}`.trim());
        break;
      case "animation":
        push(`${captionToPlainText(block.caption)} ${block.animation.media}`.trim());
        break;
      case "voice_note":
        push(`${captionToPlainText(block.caption)} ${block.voice_note.media}`.trim());
        break;
      case "map":
        push(
          `${captionToPlainText(block.caption)} ${block.location.latitude},${block.location.longitude}`.trim(),
        );
        break;
      case "divider":
      case "anchor":
        break;
    }
  }
  return result;
}

function normalizeRichCaption(caption: RichBlockCaption, depth: number): RichBlockCaption {
  return {
    text: normalizeRichText(caption.text, depth),
    ...(caption.credit === undefined ? {} : { credit: normalizeRichText(caption.credit, depth) }),
  };
}

/** Bound caller-supplied blocks before recursive splitting or wire serialization. */
export function normalizeInputRichBlocks(
  blocks: readonly InputRichBlock[],
  depth = 0,
): InputRichBlock[] {
  if (depth >= MAX_RICH_BLOCK_NESTING) {
    return [{ type: "paragraph", text: inputRichBlocksToPlainText(blocks) }];
  }
  return blocks.map((block): InputRichBlock => {
    const textDepth = depth + 1;
    switch (block.type) {
      case "paragraph":
      case "heading":
      case "footer":
        return { ...block, text: normalizeRichText(block.text, textDepth) };
      case "pullquote":
        return { ...block, ...normalizeRichCaption(block, textDepth) };
      case "blockquote":
        return {
          ...block,
          blocks: normalizeInputRichBlocks(block.blocks, depth + 1),
          ...(block.credit === undefined
            ? {}
            : { credit: normalizeRichText(block.credit, textDepth) }),
        };
      case "details":
        return {
          ...block,
          summary: normalizeRichText(block.summary, textDepth),
          blocks: normalizeInputRichBlocks(block.blocks, depth + 1),
        };
      case "list":
        return {
          ...block,
          items: block.items.map((item) => ({
            ...item,
            blocks: normalizeInputRichBlocks(item.blocks, depth + 1),
          })),
        };
      case "table":
        return {
          ...block,
          ...(block.caption === undefined
            ? {}
            : { caption: normalizeRichText(block.caption, textDepth) }),
          cells: block.cells.map((row) =>
            row.map((cell) => ({
              ...cell,
              ...(cell.text === undefined ? {} : { text: normalizeRichText(cell.text, textDepth) }),
            })),
          ),
        };
      case "collage":
      case "slideshow":
      case "photo":
      case "video":
      case "audio":
      case "animation":
      case "voice_note":
      case "map":
        return {
          ...block,
          ...("blocks" in block
            ? { blocks: normalizeInputRichBlocks(block.blocks, depth + 1) }
            : {}),
          ...(block.caption === undefined
            ? {}
            : { caption: normalizeRichCaption(block.caption, textDepth) }),
        };
      default:
        return block;
    }
  });
}
