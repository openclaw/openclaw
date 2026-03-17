function markdownToNextcloudTalk(text) {
  return text.trim();
}
function escapeNextcloudTalkMarkdown(text) {
  return text.replace(/([*_`~[\]()#>+\-=|{}!\\])/g, "\\$1");
}
function formatNextcloudTalkMention(userId) {
  return `@${userId.replace(/^@/, "")}`;
}
function formatNextcloudTalkCodeBlock(code, language) {
  const lang = language ?? "";
  return `\`\`\`${lang}
${code}
\`\`\``;
}
function formatNextcloudTalkInlineCode(code) {
  if (code.includes("`")) {
    return `\`\` ${code} \`\``;
  }
  return `\`${code}\``;
}
function stripNextcloudTalkFormatting(text) {
  return text.replace(/```[\s\S]*?```/g, "").replace(/`[^`]+`/g, "").replace(/\*\*([^*]+)\*\*/g, "$1").replace(/\*([^*]+)\*/g, "$1").replace(/_([^_]+)_/g, "$1").replace(/~~([^~]+)~~/g, "$1").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/\s+/g, " ").trim();
}
function truncateNextcloudTalkText(text, maxLength, suffix = "...") {
  if (text.length <= maxLength) {
    return text;
  }
  const truncated = text.slice(0, maxLength - suffix.length);
  const lastSpace = truncated.lastIndexOf(" ");
  if (lastSpace > maxLength * 0.7) {
    return truncated.slice(0, lastSpace) + suffix;
  }
  return truncated + suffix;
}
export {
  escapeNextcloudTalkMarkdown,
  formatNextcloudTalkCodeBlock,
  formatNextcloudTalkInlineCode,
  formatNextcloudTalkMention,
  markdownToNextcloudTalk,
  stripNextcloudTalkFormatting,
  truncateNextcloudTalkText
};
