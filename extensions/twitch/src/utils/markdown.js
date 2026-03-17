function stripMarkdownForTwitch(markdown) {
  return markdown.replace(/!\[[^\]]*]\([^)]+\)/g, "").replace(/\[([^\]]+)]\([^)]+\)/g, "$1").replace(/\*\*([^*]+)\*\*/g, "$1").replace(/__([^_]+)__/g, "$1").replace(/\*([^*]+)\*/g, "$1").replace(/_([^_]+)_/g, "$1").replace(/~~([^~]+)~~/g, "$1").replace(/```[\s\S]*?```/g, (block) => block.replace(/```[^\n]*\n?/g, "").replace(/```/g, "")).replace(/`([^`]+)`/g, "$1").replace(/^#{1,6}\s+/gm, "").replace(/^\s*[-*+]\s+/gm, "").replace(/^\s*\d+\.\s+/gm, "").replace(/\r/g, "").replace(/[ \t]+\n/g, "\n").replace(/\n/g, " ").replace(/[ \t]{2,}/g, " ").trim();
}
function chunkTextForTwitch(text, limit) {
  const cleaned = stripMarkdownForTwitch(text);
  if (!cleaned) {
    return [];
  }
  if (limit <= 0) {
    return [cleaned];
  }
  if (cleaned.length <= limit) {
    return [cleaned];
  }
  const chunks = [];
  let remaining = cleaned;
  while (remaining.length > limit) {
    const window = remaining.slice(0, limit);
    const lastSpaceIndex = window.lastIndexOf(" ");
    if (lastSpaceIndex === -1) {
      chunks.push(window);
      remaining = remaining.slice(limit);
    } else {
      chunks.push(window.slice(0, lastSpaceIndex));
      remaining = remaining.slice(lastSpaceIndex + 1);
    }
  }
  if (remaining) {
    chunks.push(remaining);
  }
  return chunks;
}
export {
  chunkTextForTwitch,
  stripMarkdownForTwitch
};
