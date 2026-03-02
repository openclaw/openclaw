export function splitModelRef(ref?: string): { provider?: string; model?: string } {
  if (!ref) {
    return { provider: undefined, model: undefined };
  }
  const trimmed = ref.trim();
  if (!trimmed) {
    return { provider: undefined, model: undefined };
  }
  const [provider, model] = trimmed.split("/", 2);
  if (provider && model) {
    return { provider, model };
  }
  return { provider: undefined, model: trimmed };
}
