import { normalizeFeishuExternalKey } from "./external-keys.js";
const FALLBACK_POST_TEXT = "[Rich text message]";
const MARKDOWN_SPECIAL_CHARS = /([\\`*_{}\[\]()#+\-!|>~])/g;
function isRecord(value) {
  return typeof value === "object" && value !== null;
}
function toStringOrEmpty(value) {
  return typeof value === "string" ? value : "";
}
function escapeMarkdownText(text) {
  return text.replace(MARKDOWN_SPECIAL_CHARS, "\\$1");
}
function toBoolean(value) {
  return value === true || value === 1 || value === "true";
}
function isStyleEnabled(style, key) {
  if (!style) {
    return false;
  }
  return toBoolean(style[key]);
}
function wrapInlineCode(text) {
  const maxRun = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(maxRun + 1);
  const needsPadding = text.startsWith("`") || text.endsWith("`");
  const body = needsPadding ? ` ${text} ` : text;
  return `${fence}${body}${fence}`;
}
function sanitizeFenceLanguage(language) {
  return language.trim().replace(/[^A-Za-z0-9_+#.-]/g, "");
}
function renderTextElement(element) {
  const text = toStringOrEmpty(element.text);
  const style = isRecord(element.style) ? element.style : void 0;
  if (isStyleEnabled(style, "code")) {
    return wrapInlineCode(text);
  }
  let rendered = escapeMarkdownText(text);
  if (!rendered) {
    return "";
  }
  if (isStyleEnabled(style, "bold")) {
    rendered = `**${rendered}**`;
  }
  if (isStyleEnabled(style, "italic")) {
    rendered = `*${rendered}*`;
  }
  if (isStyleEnabled(style, "underline")) {
    rendered = `<u>${rendered}</u>`;
  }
  if (isStyleEnabled(style, "strikethrough") || isStyleEnabled(style, "line_through") || isStyleEnabled(style, "lineThrough")) {
    rendered = `~~${rendered}~~`;
  }
  return rendered;
}
function renderLinkElement(element) {
  const href = toStringOrEmpty(element.href).trim();
  const rawText = toStringOrEmpty(element.text);
  const text = rawText || href;
  if (!text) {
    return "";
  }
  if (!href) {
    return escapeMarkdownText(text);
  }
  return `[${escapeMarkdownText(text)}](${href})`;
}
function renderMentionElement(element) {
  const mention = toStringOrEmpty(element.user_name) || toStringOrEmpty(element.user_id) || toStringOrEmpty(element.open_id);
  if (!mention) {
    return "";
  }
  return `@${escapeMarkdownText(mention)}`;
}
function renderEmotionElement(element) {
  const text = toStringOrEmpty(element.emoji) || toStringOrEmpty(element.text) || toStringOrEmpty(element.emoji_type);
  return escapeMarkdownText(text);
}
function renderCodeBlockElement(element) {
  const language = sanitizeFenceLanguage(
    toStringOrEmpty(element.language) || toStringOrEmpty(element.lang)
  );
  const code = (toStringOrEmpty(element.text) || toStringOrEmpty(element.content)).replace(
    /\r\n/g,
    "\n"
  );
  const trailingNewline = code.endsWith("\n") ? "" : "\n";
  return `\`\`\`${language}
${code}${trailingNewline}\`\`\``;
}
function renderElement(element, imageKeys, mediaKeys, mentionedOpenIds) {
  if (!isRecord(element)) {
    return escapeMarkdownText(toStringOrEmpty(element));
  }
  const tag = toStringOrEmpty(element.tag).toLowerCase();
  switch (tag) {
    case "text":
      return renderTextElement(element);
    case "a":
      return renderLinkElement(element);
    case "at":
      {
        const mentioned = toStringOrEmpty(element.open_id) || toStringOrEmpty(element.user_id);
        const normalizedMention = normalizeFeishuExternalKey(mentioned);
        if (normalizedMention) {
          mentionedOpenIds.push(normalizedMention);
        }
      }
      return renderMentionElement(element);
    case "img": {
      const imageKey = normalizeFeishuExternalKey(toStringOrEmpty(element.image_key));
      if (imageKey) {
        imageKeys.push(imageKey);
      }
      return "![image]";
    }
    case "media": {
      const fileKey = normalizeFeishuExternalKey(toStringOrEmpty(element.file_key));
      if (fileKey) {
        const fileName = toStringOrEmpty(element.file_name) || void 0;
        mediaKeys.push({ fileKey, fileName });
      }
      return "[media]";
    }
    case "emotion":
      return renderEmotionElement(element);
    case "br":
      return "\n";
    case "hr":
      return "\n\n---\n\n";
    case "code": {
      const code = toStringOrEmpty(element.text) || toStringOrEmpty(element.content);
      return code ? wrapInlineCode(code) : "";
    }
    case "code_block":
    case "pre":
      return renderCodeBlockElement(element);
    default:
      return escapeMarkdownText(toStringOrEmpty(element.text));
  }
}
function toPostPayload(candidate) {
  if (!isRecord(candidate) || !Array.isArray(candidate.content)) {
    return null;
  }
  return {
    title: toStringOrEmpty(candidate.title),
    content: candidate.content
  };
}
function resolveLocalePayload(candidate) {
  const direct = toPostPayload(candidate);
  if (direct) {
    return direct;
  }
  if (!isRecord(candidate)) {
    return null;
  }
  for (const value of Object.values(candidate)) {
    const localePayload = toPostPayload(value);
    if (localePayload) {
      return localePayload;
    }
  }
  return null;
}
function resolvePostPayload(parsed) {
  const direct = toPostPayload(parsed);
  if (direct) {
    return direct;
  }
  if (!isRecord(parsed)) {
    return null;
  }
  const wrappedPost = resolveLocalePayload(parsed.post);
  if (wrappedPost) {
    return wrappedPost;
  }
  return resolveLocalePayload(parsed);
}
function parsePostContent(content) {
  try {
    const parsed = JSON.parse(content);
    const payload = resolvePostPayload(parsed);
    if (!payload) {
      return {
        textContent: FALLBACK_POST_TEXT,
        imageKeys: [],
        mediaKeys: [],
        mentionedOpenIds: []
      };
    }
    const imageKeys = [];
    const mediaKeys = [];
    const mentionedOpenIds = [];
    const paragraphs = [];
    for (const paragraph of payload.content) {
      if (!Array.isArray(paragraph)) {
        continue;
      }
      let renderedParagraph = "";
      for (const element of paragraph) {
        renderedParagraph += renderElement(element, imageKeys, mediaKeys, mentionedOpenIds);
      }
      paragraphs.push(renderedParagraph);
    }
    const title = escapeMarkdownText(payload.title.trim());
    const body = paragraphs.join("\n").trim();
    const textContent = [title, body].filter(Boolean).join("\n\n").trim();
    return {
      textContent: textContent || FALLBACK_POST_TEXT,
      imageKeys,
      mediaKeys,
      mentionedOpenIds
    };
  } catch {
    return { textContent: FALLBACK_POST_TEXT, imageKeys: [], mediaKeys: [], mentionedOpenIds: [] };
  }
}
export {
  parsePostContent
};
