import type * as Lark from "@larksuiteoapi/node-sdk";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import { assertFeishuApiSuccess } from "./api-response.js";

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

type DocxPatchPayload = NonNullable<Parameters<Lark.Client["docx"]["documentBlock"]["patch"]>[0]>;
type DocxTextElement = NonNullable<
  NonNullable<NonNullable<DocxPatchPayload["data"]>["update_text_elements"]>["elements"]
>[number];

function parseColorMarkup(content: string): DocxTextElement[] {
  const elements: DocxTextElement[] = [];
  // Restrict opening tags so literal brackets such as [Q1] cannot consume a later
  // closing tag. Mismatched closing names retain the opening style.
  const KNOWN = "(?:bg:[a-z]+|bold|red|orange|yellow|green|blue|purple|gr[ae]y)";
  const tagPattern = new RegExp(
    `\\[(${KNOWN}(?:\\s+${KNOWN})*)\\](.*?)\\[\\/(?:[^\\]]+)\\]|([^[]+|\\[)`,
    "gis",
  );
  let match;

  while ((match = tagPattern.exec(content)) !== null) {
    const text = match[3] ?? match[2];
    if (!text) {
      continue;
    }
    let textColor: number | undefined;
    let bgColor: number | undefined;
    let bold = false;
    if (match[3] === undefined) {
      for (const tag of normalizeLowercaseStringOrEmpty(match[1]).split(/\s+/)) {
        if (tag.startsWith("bg:")) {
          const color = tag.slice(3);
          if (COLORS[color]) {
            bgColor = COLORS[color];
          }
        } else if (tag === "bold") {
          bold = true;
        } else if (COLORS[tag]) {
          textColor = COLORS[tag];
        }
      }
    }
    elements.push({
      text_run: {
        content: text,
        text_element_style: {
          ...(textColor && { text_color: textColor }),
          ...(bgColor && { background_color: bgColor }),
          ...(bold && { bold: true }),
        },
      },
    });
  }

  return elements;
}

export async function updateColorText(
  client: Lark.Client,
  docToken: string,
  blockId: string,
  content: string,
) {
  const elements = parseColorMarkup(content);

  const res = await client.docx.documentBlock.patch({
    path: { document_id: docToken, block_id: blockId },
    data: { update_text_elements: { elements } },
  });

  assertFeishuApiSuccess(res);

  return {
    success: true,
    segments: elements.length,
    block: res.data?.block,
  };
}
