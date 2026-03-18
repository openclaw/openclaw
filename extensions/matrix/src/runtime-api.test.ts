import { describe, expect, it } from "vitest";
import * as runtimeApi from "../runtime-api.js";

describe("matrix runtime-api", () => {
  it("re-exports createAccountListHelpers as a live runtime value", () => {
    expect(typeof runtimeApi.createAccountListHelpers).toBe("function");

    const helpers = runtimeApi.createAccountListHelpers("matrix");
    expect(typeof helpers.listAccountIds).toBe("function");
    expect(typeof helpers.resolveDefaultAccountId).toBe("function");
  });

  it("does not re-export setup entrypoints that create extension cycles", () => {
    expect("matrixSetupWizard" in runtimeApi).toBe(false);
    expect("matrixSetupAdapter" in runtimeApi).toBe(false);
  });
});
