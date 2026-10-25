// Verifies model catalog lookup scope for custom and manifest-owned models.
import { describe, expect, it } from "vitest";
import { resolveModelCatalogScope } from "../plugins/provider-config-owner.js";
import { configFor, modelDefinition } from "./model-auth.fixtures.test-support.js";

describe("resolveModelCatalogScope", () => {
  it("keeps explicit custom provider models scoped to that provider", () => {
    // Custom provider model ids may collide with built-ins, so lookup should
    // not fall through to bare manifest refs.
    const cfg = configFor("tui-pty-mock", "http://127.0.0.1:64087/v1", {
      api: "openai-responses",
      models: [modelDefinition("gpt-5.5", { contextWindow: 128_000 })],
    });

    expect(
      resolveModelCatalogScope({
        cfg,
        provider: "tui-pty-mock",
        model: "gpt-5.5",
      }),
    ).toEqual(["tui-pty-mock/gpt-5.5"]);
  });

  it("keeps bare model refs for manifest-owned model lookup", () => {
    expect(
      resolveModelCatalogScope({
        cfg: {},
        provider: "openai",
        model: "gpt-5.4",
      }),
    ).toEqual(["openai/gpt-5.4", "gpt-5.4"]);
  });
});
