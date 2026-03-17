function inferSlackChannelType(channelId) {
  const trimmed = channelId?.trim();
  if (!trimmed) {
    return void 0;
  }
  if (trimmed.startsWith("D")) {
    return "im";
  }
  if (trimmed.startsWith("C")) {
    return "channel";
  }
  if (trimmed.startsWith("G")) {
    return "group";
  }
  return void 0;
}
function normalizeSlackChannelType(channelType, channelId) {
  const normalized = channelType?.trim().toLowerCase();
  const inferred = inferSlackChannelType(channelId);
  if (normalized === "im" || normalized === "mpim" || normalized === "channel" || normalized === "group") {
    if (inferred === "im" && normalized !== "im") {
      return "im";
    }
    return normalized;
  }
  return inferred ?? "channel";
}
export {
  inferSlackChannelType,
  normalizeSlackChannelType
};
