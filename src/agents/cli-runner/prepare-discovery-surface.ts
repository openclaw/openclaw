import type { ResolvedCliBackend } from "../cli-backends.js";
import { resolveCliBootstrapFileAccess, withCliToolSearch } from "./prepare-tool-policy.js";
import type { RunCliAgentParams } from "./types.js";

export function prepareCliDiscoverySurface(input: {
  params: RunCliAgentParams;
  backend: ResolvedCliBackend;
  projectedTools: readonly { name: string }[];
  managedNativeTools: readonly string[];
}) {
  const params = withCliToolSearch(input.params, input.backend.nativeToolSearch);
  // Bootstrap routing uses the final native or mediated file surface.
  const hasBootstrapFileAccess = resolveCliBootstrapFileAccess({
    backend: input.backend,
    params,
    managedNativeTools: input.managedNativeTools,
    projectedToolNames: input.projectedTools.map((tool) => tool.name),
  });
  return { params, hasBootstrapFileAccess };
}
