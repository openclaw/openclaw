import { parseZalouserTextStyles } from "./text-styles.js";
import {
  sendZaloDeliveredEvent,
  sendZaloLink,
  sendZaloReaction,
  sendZaloSeenEvent,
  sendZaloTextMessage,
  sendZaloTypingEvent
} from "./zalo-js.js";
import { TextStyle } from "./zca-client.js";
const ZALO_TEXT_LIMIT = 2e3;
const DEFAULT_TEXT_CHUNK_MODE = "length";
async function sendMessageZalouser(threadId, text, options = {}) {
  const prepared = options.textMode === "markdown" ? parseZalouserTextStyles(text) : { text, styles: options.textStyles };
  const textChunkLimit = options.textChunkLimit ?? ZALO_TEXT_LIMIT;
  const chunks = splitStyledText(
    prepared.text,
    (prepared.styles?.length ?? 0) > 0 ? prepared.styles : void 0,
    textChunkLimit,
    options.textChunkMode
  );
  let lastResult = null;
  for (const [index, chunk] of chunks.entries()) {
    const chunkOptions = index === 0 ? { ...options, textStyles: chunk.styles } : {
      ...options,
      caption: void 0,
      mediaLocalRoots: void 0,
      mediaUrl: void 0,
      textStyles: chunk.styles
    };
    const result = await sendZaloTextMessage(threadId, chunk.text, chunkOptions);
    if (!result.ok) {
      return result;
    }
    lastResult = result;
  }
  return lastResult ?? { ok: false, error: "No message content provided" };
}
async function sendImageZalouser(threadId, imageUrl, options = {}) {
  return await sendMessageZalouser(threadId, options.caption ?? "", {
    ...options,
    caption: void 0,
    mediaUrl: imageUrl
  });
}
async function sendLinkZalouser(threadId, url, options = {}) {
  return await sendZaloLink(threadId, url, options);
}
async function sendTypingZalouser(threadId, options = {}) {
  await sendZaloTypingEvent(threadId, options);
}
async function sendReactionZalouser(params) {
  const result = await sendZaloReaction({
    profile: params.profile,
    threadId: params.threadId,
    isGroup: params.isGroup,
    msgId: params.msgId,
    cliMsgId: params.cliMsgId,
    emoji: params.emoji,
    remove: params.remove
  });
  return {
    ok: result.ok,
    error: result.error
  };
}
async function sendDeliveredZalouser(params) {
  await sendZaloDeliveredEvent(params);
}
async function sendSeenZalouser(params) {
  await sendZaloSeenEvent(params);
}
function splitStyledText(text, styles, limit, mode) {
  if (text.length === 0) {
    return [{ text, styles: void 0 }];
  }
  const chunks = [];
  for (const range of splitTextRanges(text, limit, mode ?? DEFAULT_TEXT_CHUNK_MODE)) {
    const { start, end } = range;
    chunks.push({
      text: text.slice(start, end),
      styles: sliceTextStyles(styles, start, end)
    });
  }
  return chunks;
}
function sliceTextStyles(styles, start, end) {
  if (!styles || styles.length === 0) {
    return void 0;
  }
  const chunkStyles = styles.map((style) => {
    const overlapStart = Math.max(style.start, start);
    const overlapEnd = Math.min(style.start + style.len, end);
    if (overlapEnd <= overlapStart) {
      return null;
    }
    if (style.st === TextStyle.Indent) {
      return {
        start: overlapStart - start,
        len: overlapEnd - overlapStart,
        st: style.st,
        indentSize: style.indentSize
      };
    }
    return {
      start: overlapStart - start,
      len: overlapEnd - overlapStart,
      st: style.st
    };
  }).filter((style) => style !== null);
  return chunkStyles.length > 0 ? chunkStyles : void 0;
}
function splitTextRanges(text, limit, mode) {
  if (mode === "newline") {
    return splitTextRangesByPreferredBreaks(text, limit);
  }
  const ranges = [];
  for (let start = 0; start < text.length; start += limit) {
    ranges.push({
      start,
      end: Math.min(text.length, start + limit)
    });
  }
  return ranges;
}
function splitTextRangesByPreferredBreaks(text, limit) {
  const ranges = [];
  let start = 0;
  while (start < text.length) {
    const maxEnd = Math.min(text.length, start + limit);
    let end = maxEnd;
    if (maxEnd < text.length) {
      end = findParagraphBreak(text, start, maxEnd) ?? findLastBreak(text, "\n", start, maxEnd) ?? findLastWhitespaceBreak(text, start, maxEnd) ?? maxEnd;
    }
    if (end <= start) {
      end = maxEnd;
    }
    ranges.push({ start, end });
    start = end;
  }
  return ranges;
}
function findParagraphBreak(text, start, end) {
  const slice = text.slice(start, end);
  const matches = slice.matchAll(/\n[\t ]*\n+/g);
  let lastMatch;
  for (const match of matches) {
    lastMatch = match;
  }
  if (!lastMatch || lastMatch.index === void 0) {
    return void 0;
  }
  return start + lastMatch.index + lastMatch[0].length;
}
function findLastBreak(text, marker, start, end) {
  const index = text.lastIndexOf(marker, end - 1);
  if (index < start) {
    return void 0;
  }
  return index + marker.length;
}
function findLastWhitespaceBreak(text, start, end) {
  for (let index = end - 1; index > start; index -= 1) {
    if (/\s/.test(text[index])) {
      return index + 1;
    }
  }
  return void 0;
}
export {
  sendDeliveredZalouser,
  sendImageZalouser,
  sendLinkZalouser,
  sendMessageZalouser,
  sendReactionZalouser,
  sendSeenZalouser,
  sendTypingZalouser
};
