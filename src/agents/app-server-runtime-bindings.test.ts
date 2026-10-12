// Guards that every bundled app-server agent harness has a runtime-chooser binding.
import { describe, expect, it } from "vitest";
import { listAppServerRuntimeModelBackendBindings } from "./app-server-runtime-bindings.js";
import { listBundledAppServerHarnessIds } from "./app-server-runtime-bindings.test-support.js";

describe("listAppServerRuntimeModelBackendBindings", () => {
  it("binds every bundled app-server harness to a model provider", () => {
    const { fixed, dynamic } = listBundledAppServerHarnessIds();
    // A vacuous pass would hide the very regression this test exists to catch,
    // and a vacuous exclusion would hide a drifted dynamic-harness list.
    expect(fixed.length).toBeGreaterThan(0);
    expect(dynamic.length).toBeGreaterThan(0);

    const boundRuntimes = new Set(
      listAppServerRuntimeModelBackendBindings().map((binding) => binding.runtime),
    );
    const unbound = fixed.filter((harnessId) => !boundRuntimes.has(harnessId));
    expect(
      unbound,
      `bundled agent harness(es) ${unbound.join(", ")} have no model-provider binding, so /models offers no runtime chooser for the provider(s) they serve. Add a row to APP_SERVER_RUNTIME_MODEL_BACKEND_BINDINGS in src/agents/app-server-runtime-bindings.ts.`,
    ).toEqual([]);
    expect(
      dynamic.filter((harnessId) => boundRuntimes.has(harnessId)),
      "a dynamic-applicability harness gained a fixed binding row, so the table now claims to own routes its harness discovers per model",
    ).toEqual([]);
  });
});
