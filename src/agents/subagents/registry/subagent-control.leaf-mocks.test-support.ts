import { vi } from "vitest";
import { applySessionEntryExactReplacements } from "../../../config/sessions/session-accessor.sqlite-replacement-projection.js";
import type { loadAgentRuntimePluginRegistryHandle } from "../../runtime-plugins.js";

vi.mock("../../../browser-lifecycle-cleanup.js", { spy: true });
vi.mock("../../../context-engine/init.js", { spy: true });
vi.mock("../../../context-engine/registry.js", { spy: true });
vi.mock("../../runtime-plugins.js", async () => {
  const { getActivePluginRegistry } = await import("../../../plugins/runtime.js");
  const { createEmptyPluginRegistry } = await import("../../../plugins/registry-empty.js");
  return {
    loadAgentRuntimePluginRegistryHandle: vi.fn<typeof loadAgentRuntimePluginRegistryHandle>(
      () => getActivePluginRegistry() ?? createEmptyPluginRegistry(),
    ),
  };
});
vi.mock("./subagent-registry-state.js", { spy: true });

vi.mock("../../../config/sessions/session-accessor.sqlite-replacement-projection.js", {
  spy: true,
});

const { applySessionEntryExactReplacements: replaceCanonicalSessionEntries } =
  await vi.importActual<
    typeof import("../../../config/sessions/session-accessor.sqlite-replacement-projection.js")
  >("../../../config/sessions/session-accessor.sqlite-replacement-projection.js");

export function mockSessionReplacementForStore(
  storePath: string,
  implementation: typeof applySessionEntryExactReplacements,
) {
  // Restrict each fault to its selected session store.
  vi.mocked(applySessionEntryExactReplacements).mockImplementation((params) =>
    params.storePath === storePath
      ? implementation(params)
      : replaceCanonicalSessionEntries(params),
  );
}
