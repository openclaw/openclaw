import { describe, expect, it } from "vitest";
import * as runtimeApi from "../runtime-api.js";

describe("matrix runtime-api", () => {
  it("re-exports createAccountListHelpers as a live runtime value", () => {
    expect(typeof runtimeApi.createAccountListHelpers).toBe("function");

    const helpers = runtimeApi.createAccountListHelpers("matrix");
    expect(typeof helpers.listAccountIds).toBe("function");
    expect(typeof helpers.resolveDefaultAccountId).toBe("function");
  });

  it("re-exports buildSecretInputSchema for config schema helpers", () => {
    expect(typeof runtimeApi.buildSecretInputSchema).toBe("function");
  });

  it("re-exports setup entrypoints from the bundled plugin-sdk surface", () => {
    expect(typeof runtimeApi.matrixSetupWizard).toBe("object");
    expect(typeof runtimeApi.matrixSetupAdapter).toBe("object");
  });
});
