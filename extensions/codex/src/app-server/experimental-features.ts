import type {
  CodexExperimentalFeatureListParams,
  CodexExperimentalFeatureListResponse,
} from "./protocol-control-plane.js";

export async function readCodexExperimentalFeature(
  request: (
    params: CodexExperimentalFeatureListParams,
  ) => Promise<CodexExperimentalFeatureListResponse>,
  featureName: string,
  threadId?: string,
): Promise<boolean | undefined> {
  let cursor: string | null | undefined;
  const visited = new Set<string>();
  do {
    const response = await request({
      ...(threadId ? { threadId } : {}),
      ...(cursor ? { cursor } : {}),
      limit: 100,
    });
    const feature = response.data.find((entry) => entry.name === featureName);
    if (feature) {
      return feature.enabled;
    }
    cursor = response.nextCursor;
    if (cursor && visited.has(cursor)) {
      return undefined;
    }
    if (cursor) {
      visited.add(cursor);
    }
  } while (cursor);
  return undefined;
}
