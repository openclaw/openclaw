export function xaiPluginConfig(options: {
  enabled?: boolean;
  webSearch?: Record<string, unknown>;
  xSearch?: Record<string, unknown>;
  codeExecution?: Record<string, unknown>;
}) {
  const { enabled, ...config } = options;
  const xai = { ...(enabled === undefined ? {} : { enabled }), config };
  return { plugins: { entries: { xai } } };
}
