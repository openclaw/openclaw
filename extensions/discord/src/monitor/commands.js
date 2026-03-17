function resolveDiscordSlashCommandConfig(raw) {
  return {
    ephemeral: raw?.ephemeral !== false
  };
}
export {
  resolveDiscordSlashCommandConfig
};
