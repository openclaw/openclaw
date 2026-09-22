import { expect, vi } from "vitest";
import { isPathInside } from "../../infra/path-guards.js";
import * as pluginDiscovery from "../../plugins/discovery.js";
import * as authProfileStore from "../auth-profiles/store-runtime.js";

export function guardModelFixtureAuth(root: string) {
  const violations: Array<string | undefined> = [];
  const loadAuthProfileStoreForRuntime = authProfileStore.loadAuthProfileStoreForRuntime;
  const spy = vi
    .spyOn(authProfileStore, "loadAuthProfileStoreForRuntime")
    .mockImplementation((dir, options, env) => {
      // Any necessary native auth reads must remain inside the fixture's owned state.
      // Record even swallowed violations before the owner can inspect the path.
      if (!dir || !isPathInside(root, dir)) {
        violations.push(dir);
        throw new Error("Auth profile request escaped the model fixture");
      }
      if (options?.readOnly !== true) {
        violations.push(dir);
        throw new Error("Model fixture auth request must be read-only");
      }
      return loadAuthProfileStoreForRuntime(dir, options, env);
    });
  return { spy, verify: () => expect(violations).toEqual([]) };
}

export function guardModelFixtureWorkspace(root: string) {
  const violations: string[] = [];
  const discoverOpenClawPlugins = pluginDiscovery.discoverOpenClawPlugins;
  const spy = vi.spyOn(pluginDiscovery, "discoverOpenClawPlugins").mockImplementation((params) => {
    // This is before discovery's realpath/stat probes; bundled roots remain real.
    if (params.workspaceDir && !isPathInside(root, params.workspaceDir)) {
      violations.push(params.workspaceDir);
      throw new Error("Workspace discovery escaped the model fixture");
    }
    return discoverOpenClawPlugins(params);
  });
  return { spy, verify: () => expect(violations).toEqual([]) };
}
