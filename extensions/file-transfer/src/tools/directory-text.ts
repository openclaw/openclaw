import { wrapExternalContent } from "openclaw/plugin-sdk/security-runtime";

export function renderDirectoryText<T>(params: {
  entries: readonly T[];
  project: (entry: T) => Record<string, unknown>;
  render: (visible: readonly string[]) => { manifest: string; text: string };
  fallback: string;
}): string {
  const visible: string[] = [];
  const render = () => {
    const { manifest, text } = params.render(visible);
    const wrapped = wrapExternalContent(text, { source: "unknown" });
    // Keep complete paths unchanged by sanitization and count the wrapper in the budget.
    return wrapped.includes(manifest) && Buffer.byteLength(wrapped, "utf8") <= 8192
      ? wrapped
      : undefined;
  };
  let text = render();
  for (const entry of params.entries) {
    visible.push(JSON.stringify(params.project(entry)));
    const candidate = render();
    if (!candidate) {
      break;
    }
    text = candidate;
  }
  return text ?? wrapExternalContent(params.fallback, { source: "unknown" });
}
