import { materializeBundleMcpToolsForRun } from "./agent-bundle-mcp-materialize.js";

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
