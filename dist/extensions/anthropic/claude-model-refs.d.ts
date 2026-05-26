//#region extensions/anthropic/claude-model-refs.d.ts
type ClaudeCliAnthropicModelRefs = {
  selectedRef: string;
  runtimeRefs: string[];
  rewriteRef?: string;
};
declare function resolveClaudeCliAnthropicModelRefs(raw: string): ClaudeCliAnthropicModelRefs | null;
declare function resolveKnownAnthropicModelRef(raw?: string): string | null;
//#endregion
export { ClaudeCliAnthropicModelRefs, resolveClaudeCliAnthropicModelRefs, resolveKnownAnthropicModelRef };