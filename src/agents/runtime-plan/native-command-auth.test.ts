import { expect, it } from "vitest";
import { model, providerConfig } from "../model-catalog-fixtures.test-support.js";
import { prepareAuthFixture } from "./prepare-auth.test-support.js";

it.each(["profile", "plaintext"])(
  "refuses %s credential leakage before native execution",
  (risk) => {
    expect(() =>
      prepareAuthFixture({
        provider: "command-fixture",
        modelId: "native",
        config: providerConfig("command-fixture", {
          auth: "native-command",
          api: "openai-responses",
          baseUrl: risk === "plaintext" ? "http://fixture.test/v1" : "https://fixture.test/v1",
          agentRuntime: { id: "codex" },
          models: [model("native")],
        }),
        harnessId: "codex",
        harnessRuntime: "codex",
        harnessAuthBootstrap: "harness",
        sessionAuthProfileId: risk === "profile" ? "openai:decoy" : undefined,
      }),
    ).toThrow(risk === "profile" ? "auth profile binding" : "configured HTTPS Responses endpoint");
  },
);
