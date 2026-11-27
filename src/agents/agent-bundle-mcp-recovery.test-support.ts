import { materializeBundleMcpToolsForRun } from "./agent-bundle-mcp-materialize.js";
import { waitForRuntimeState } from "./agent-bundle-mcp-stdio.test-support.js";
import type { SessionMcpRuntime } from "./agent-bundle-mcp-types.js";

export async function refreshMcpCatalog(runtime: SessionMcpRuntime, signal: AbortSignal) {
  const previous = await runtime.getCatalog();
  await waitForRuntimeState(
    () => {
      const current = runtime.peekCatalog();
      return current !== null && current !== previous && !current.diagnostics?.length;
    },
    "successful background catalog refresh",
    signal,
  );
  return runtime.getCatalog();
}

export async function snapshotMcpTools(
  params: Parameters<typeof materializeBundleMcpToolsForRun>[0],
) {
  const prepared = await materializeBundleMcpToolsForRun(params);
  try {
    return {
      bytes: JSON.stringify(
        prepared.tools.map(({ name, description, parameters }) => ({
          name,
          description,
          parameters,
        })),
      ),
      diagnostics: prepared.diagnostics ?? [],
    };
  } finally {
    await prepared.dispose();
  }
}
