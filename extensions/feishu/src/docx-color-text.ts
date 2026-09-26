import type * as Lark from "@larksuiteoapi/node-sdk";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";

// Feishu uses the same values for these foreground and background colors.
const COLORS: Record<string, number> = {
  red: 1, // Pink (closest to red in Feishu)
  orange: 2,
  yellow: 3,
  green: 4,
  blue: 5,
  purple: 6,
  grey: 7,
  gray: 7,
};

interface Segment {
  text: string;
  textColor?: number;
  bgColor?: number;
  bold?: boolean;
}

type DocxPatchPayload = NonNullable<Parameters<Lark.Client["docx"]["documentBlock"]["patch"]>[0]>;
type DocxTextElement = NonNullable<
  NonNullable<NonNullable<DocxPatchPayload["data"]>["update_text_elements"]>["elements"]
>[number];

function parseColorMarkup(content: string): Segment[] {
  const segments: Segment[] = [];
  // Restrict opening tags so literal brackets such as [Q1] cannot consume a later
  // closing tag. Mismatched closing names retain the opening style.
  const KNOWN = "(?:bg:[a-z]+|bold|red|orange|yellow|green|blue|purple|gr[ae]y)";
  const tagPattern = new RegExp(
    `\\[(${KNOWN}(?:\\s+${KNOWN})*)\\](.*?)\\[\\/(?:[^\\]]+)\\]|([^[]+|\\[)`,
    "gis",
  );
  let match;

  while ((match = tagPattern.exec(content)) !== null) {
    if (match[3] !== undefined) {
      if (match[3]) {
        segments.push({ text: match[3] });
      }
    } else {
      const tagStr = normalizeLowercaseStringOrEmpty(match[1]);
      const text = match[2];
      if (text === undefined) {
        continue;
      }
      const tags = tagStr.split(/\s+/);

      const segment: Segment = { text };

      for (const tag of tags) {
        if (tag.startsWith("bg:")) {
          const color = tag.slice(3);
          if (COLORS[color]) {
            segment.bgColor = COLORS[color];
          }
        } else if (tag === "bold") {
          segment.bold = true;
        } else if (COLORS[tag]) {
          segment.textColor = COLORS[tag];
        }
      }

      if (text) {
        segments.push(segment);
      }
    }
  }

  return segments;
}

export async function updateColorText(
  client: Lark.Client,
  docToken: string,
  blockId: string,
  content: string,
) {
  const segments = parseColorMarkup(content);

  const elements: DocxTextElement[] = segments.map((seg) => ({
    text_run: {
      content: seg.text,
      text_element_style: {
        ...(seg.textColor && { text_color: seg.textColor }),
        ...(seg.bgColor && { background_color: seg.bgColor }),
        ...(seg.bold && { bold: true }),
      },
    },
  }));

  const res = await client.docx.documentBlock.patch({
    path: { document_id: docToken, block_id: blockId },
    data: { update_text_elements: { elements } },
  });

  if (res.code !== 0) {
    throw new Error(res.msg);
  }

  return {
    success: true,
    segments: segments.length,
    block: res.data?.block,
  };
}
