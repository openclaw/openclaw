import { resolveNodeRuntimeExecutableAsync } from "openclaw/plugin-sdk/process-runtime";

export async function resolveQaNodeExecPath(): Promise<string> {
  const resolved = await resolveNodeRuntimeExecutableAsync();
  if (!resolved) {
    throw new Error(
      "Node not found in PATH. QA live lanes require Node for child gateway and CLI processes.",
    );
  }
  return resolved;
}
