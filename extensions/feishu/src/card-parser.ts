type CardElement = Record<string, unknown>;

function getElements(obj: CardElement | null | undefined): CardElement[] | null {
  if (!obj || typeof obj !== "object") return null;
  if (obj.elements && Array.isArray(obj.elements)) return obj.elements as CardElement[];
  const prop = obj.property as CardElement | undefined;
  if (prop?.elements && Array.isArray(prop.elements)) return prop.elements as CardElement[];
  const fallbackProp = (obj.fallback as CardElement | undefined)?.property as
    | CardElement
    | undefined;
  if (fallbackProp?.elements && Array.isArray(fallbackProp.elements))
    return fallbackProp.elements as CardElement[];
  return null;
}

function getContent(obj: CardElement | null | undefined): string | null {
  if (!obj || typeof obj !== "object") return null;
  if (obj.content) return String(obj.content);
  const prop = obj.property as CardElement | undefined;
  if (prop?.content) return String(prop.content);
  const fallbackProp = (obj.fallback as CardElement | undefined)?.property as
    | CardElement
    | undefined;
  if (fallbackProp?.content) return String(fallbackProp.content);
  return null;
}

function safeStringify(obj: unknown, depth = 0): string {
  if (depth > 3) return "[max depth]";
  if (!obj || typeof obj !== "object") return String(obj);
  if (Array.isArray(obj)) {
    return obj.map((x) => safeStringify(x, depth + 1)).join(", ");
  }
  const parts: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    if (k === "id" || k === "tag") continue;
    parts.push(`${k}: ${safeStringify(v, depth + 1)}`);
  }
  return parts.join(", ");
}

function parseFeishuCardToMarkdown(obj: CardElement | null | undefined, depth = 0): string {
  if (!obj || typeof obj !== "object") return "";
  if (depth > 10) return "[max recursion depth]";

  try {
    if (!obj.tag && (obj.body || obj.header)) {
      const parts: string[] = [];
      if (obj.header) parts.push(parseFeishuCardToMarkdown(obj.header as CardElement, depth + 1));
      if (obj.body) {
        const body = obj.body as CardElement;
        const bodyProp = body.property as CardElement | undefined;
        const elems = getElements(body) || (bodyProp?.elements ? [bodyProp] : []);
        if (Array.isArray(elems)) {
          parts.push(elems.map((e) => parseFeishuCardToMarkdown(e, depth + 1)).join("\n"));
        }
      }
      return parts.filter(Boolean).join("\n");
    }

    const tag = String(obj.tag ?? "");

    if (tag === "body") {
      const elems = getElements(obj);
      if (elems) return elems.map((e) => parseFeishuCardToMarkdown(e, depth + 1)).join("\n");
      if (obj.property) return parseFeishuCardToMarkdown(obj.property as CardElement, depth + 1);
      return "";
    }

    switch (tag) {
      case "plain_text":
      case "markdown":
      case "markdown_v1": {
        const content = getContent(obj);
        if (content && /^[\[\]]+$/.test(content)) {
          const elems = getElements(obj);
          if (elems) {
            return elems.map((e) => parseFeishuCardToMarkdown(e, depth + 1)).join("");
          }
          return "";
        }
        if (content) return content;
        const elems = getElements(obj);
        if (elems) {
          return elems.map((e) => parseFeishuCardToMarkdown(e, depth + 1)).join("");
        }
        return "";
      }

      case "heading": {
        const level =
          (obj.level as number) ||
          ((obj.property as Record<string, unknown>)?.level as number) ||
          1;
        const content = getContent(obj);
        if (content) return `${"#".repeat(level)} ${content}\n\n`;
        const elems = getElements(obj);
        if (elems)
          return `${"#".repeat(level)} ${elems.map((e) => parseFeishuCardToMarkdown(e, depth + 1)).join("")}\n\n`;
        return "";
      }

      case "list": {
        const property = obj.property as Record<string, unknown> | undefined;
        const items = property?.items as Array<Record<string, unknown>> | undefined;
        const listType =
          property?.type === "ol" || (items?.[0] && "order" in items[0]) ? "ol" : "ul";
        if (items && Array.isArray(items)) {
          return (
            items
              .map((item, idx) => {
                const itemElements = (item.elements as CardElement[]) || [];
                const text = itemElements
                  .map((e) => parseFeishuCardToMarkdown(e, depth + 1))
                  .join("");
                return `${listType === "ol" ? (item.order || idx + 1) + "." : "-"} ${text}`;
              })
              .filter(Boolean)
              .join("\n") + "\n"
          );
        }
        return "";
      }

      case "code_span": {
        const content = getContent(obj);
        return content ? `\`${content}\`` : "";
      }

      case "card_header": {
        const title = obj.title || (obj.property as Record<string, unknown>)?.title;
        if (!title) return "";
        // If title is an object (like { tag: "plain_text", content: "..." }), parse it recursively
        if (typeof title === "object") {
          const parsed = parseFeishuCardToMarkdown(title as CardElement, depth + 1);
          return parsed ? `# ${parsed}\n\n` : "";
        }
        // If title is a string
        return `# ${String(title)}\n\n`;
      }

      case "blockquote": {
        const elems = getElements(obj);
        if (elems) {
          const inner = elems.map((e) => parseFeishuCardToMarkdown(e, depth + 1)).join("");
          return (
            "\n" +
            inner
              .split("\n")
              .map((line) => `> ${line}`)
              .join("\n") +
            "\n"
          );
        }
        return "";
      }

      case "action": {
        const property = obj.property as Record<string, unknown> | undefined;
        const actions = property?.actions as CardElement[] | undefined;
        if (actions && Array.isArray(actions)) {
          return actions.map((a) => parseFeishuCardToMarkdown(a, depth + 1)).join(" ");
        }
        return "";
      }

      case "button": {
        const property = obj.property as Record<string, unknown> | undefined;
        const text = property?.text;
        const actions = property?.actions as CardElement[] | undefined;
        if (actions && Array.isArray(actions)) {
          return actions
            .map((ia) => {
              const iaObj = ia as Record<string, unknown>;
              const url = (iaObj.action as Record<string, unknown>)?.url || iaObj.url;
              const textObj = text as Record<string, unknown> | undefined;
              const textProp = textObj?.property as CardElement | undefined;
              const btnText =
                typeof text === "string"
                  ? text
                  : (textProp?.content as string) || (textObj?.content as string) || "button";
              return url ? `[${btnText}](${url})` : btnText;
            })
            .join(" ");
        }
        // Fallback: render button text without a URL
        const textObj = text as Record<string, unknown> | undefined;
        const textProp = textObj?.property as CardElement | undefined;
        const btnText =
          typeof text === "string"
            ? text
            : (textProp?.content as string) || (textObj?.content as string) || "";
        return btnText;
      }

      case "action_link": {
        const url =
          (obj.url as string) ||
          ((obj.action as Record<string, unknown>)?.url as string) ||
          ((obj.property as Record<string, unknown>)?.url as string);
        const text =
          (obj.text as string) ||
          ((obj.property as Record<string, unknown>)?.text as string) ||
          "link";
        return url ? `[${text}](${url})` : text;
      }

      case "link": {
        const content = getContent(obj) || (obj.text as string) || "";
        const urlObj =
          (obj.url as string) || ((obj.property as Record<string, unknown>)?.url as string);
        const url =
          typeof urlObj === "string"
            ? urlObj
            : ((urlObj as Record<string, unknown>)?.url as string) || "";
        return url ? `[${content}](${url})` : content;
      }

      case "table": {
        const property = obj.property as Record<string, unknown> | undefined;
        const columns = property?.columns as Array<{ displayName?: string }> | undefined;
        const rows = property?.rows as Record<string, unknown>[] | undefined;
        if (!columns || !rows) return "";
        const header = "| " + columns.map((c) => c.displayName || "").join(" | ") + " |";
        const sep = "| " + columns.map(() => "---").join(" | ") + " |";
        const body = rows
          .map((row) => {
            return (
              "| " +
              columns
                .map((_, idx) => {
                  const cell = row[idx.toString()] as Record<string, unknown> | undefined;
                  if (!cell) return "";
                  const cellData = cell.data as Record<string, unknown> | undefined;
                  const cellDataProp = cellData?.property as CardElement | undefined;
                  if (cellDataProp?.elements) {
                    return (cellDataProp.elements as CardElement[])
                      .map((e) => parseFeishuCardToMarkdown(e, depth + 1))
                      .join("");
                  }
                  return (cellData?.content as string) || "";
                })
                .join(" | ") +
              " |"
            );
          })
          .join("\n");
        return `\n${header}\n${sep}\n${body}\n`;
      }

      case "code_block": {
        const property = obj.property as Record<string, unknown> | undefined;
        const contents = property?.contents as Array<Record<string, unknown>> | undefined;
        if (contents && Array.isArray(contents)) {
          const text = contents
            .map((c) => {
              const inner = (c.contents as unknown) || c;
              if (Array.isArray(inner)) {
                return inner.map((x) => (x as Record<string, unknown>).content || "").join("");
              }
              return ((inner as Record<string, unknown>).content as string) || "";
            })
            .join("");
          const language = property?.language as string | undefined;
          return `\n\`\`\`${language || ""}\n${text}\n\`\`\`\n`;
        }
        return "";
      }

      case "br":
        return "\n";

      case "hr":
        return "\n---\n\n";

      case "div": {
        const elems = getElements(obj);
        if (elems) return elems.map((e) => parseFeishuCardToMarkdown(e, depth + 1)).join("");
        return ((obj.text as Record<string, unknown>)?.content as string) || "";
      }

      default: {
        const content = getContent(obj);
        if (content) return content;
        const elems = getElements(obj);
        if (elems) return elems.map((e) => parseFeishuCardToMarkdown(e, depth + 1)).join("\n");
        return `[${obj.tag || "unknown"}: ${safeStringify(obj.property || obj)}]`;
      }
    }
  } catch (e) {
    return `[parse error: ${(e as Error).message}]`;
  }
}

function cleanMarkdown(text: string): string {
  if (typeof text !== "string") return "";
  return text.replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * Parse a Feishu interactive card JSON object to markdown text.
 * Extracts text content from various card elements including:
 * - plain_text, markdown, markdown_v1
 * - heading
 * - list (ordered and unordered)
 * - table
 * - code_block, code_span
 * - link, action_link
 * - button, action
 * - div, br, hr
 * - card_header
 *
 * Falls back gracefully for unknown tags or parse errors.
 */
export function parseFeishuCardToMarkdownString(cardJson: string | unknown): string {
  let parsed: unknown;
  if (typeof cardJson === "string") {
    try {
      parsed = JSON.parse(cardJson);
    } catch {
      return "[Interactive Card]";
    }
  } else {
    parsed = cardJson;
  }

  if (!parsed || typeof parsed !== "object") {
    return "[Interactive Card]";
  }

  const result = parseFeishuCardToMarkdown(parsed as CardElement);
  return cleanMarkdown(result) || "[Interactive Card]";
}
