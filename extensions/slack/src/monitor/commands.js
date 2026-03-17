function stripSlackMentionsForCommandDetection(text) {
  return (text ?? "").replace(/<@[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}
function normalizeSlackSlashCommandName(raw) {
  return raw.replace(/^\/+/, "");
}
function resolveSlackSlashCommandConfig(raw) {
  const normalizedName = normalizeSlackSlashCommandName(raw?.name?.trim() || "openclaw");
  const name = normalizedName || "openclaw";
  return {
    enabled: raw?.enabled === true,
    name,
    sessionPrefix: raw?.sessionPrefix?.trim() || "slack:slash",
    ephemeral: raw?.ephemeral !== false
  };
}
function buildSlackSlashCommandMatcher(name) {
  const normalized = normalizeSlackSlashCommandName(name);
  const escaped = normalized.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^/?${escaped}$`);
}
export {
  buildSlackSlashCommandMatcher,
  normalizeSlackSlashCommandName,
  resolveSlackSlashCommandConfig,
  stripSlackMentionsForCommandDetection
};
