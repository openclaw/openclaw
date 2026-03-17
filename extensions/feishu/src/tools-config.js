const DEFAULT_TOOLS_CONFIG = {
  doc: true,
  chat: true,
  wiki: true,
  drive: true,
  perm: false,
  scopes: true
};
function resolveToolsConfig(cfg) {
  return { ...DEFAULT_TOOLS_CONFIG, ...cfg };
}
export {
  DEFAULT_TOOLS_CONFIG,
  resolveToolsConfig
};
