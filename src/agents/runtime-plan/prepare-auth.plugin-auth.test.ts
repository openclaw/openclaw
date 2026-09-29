import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { AuthProfileStore } from "../auth-profiles/types.js";
import { prepareAgentRuntimeAuth } from "./prepare-auth.js";

describe("plugin-owned authentication", () => {
  it("prepares only the selected plugin owner despite an unavailable shared profile pin", () => {
    const prepared = prepareAgentRuntimeAuth({
      provider: "openai",
      modelId: "plugin-model",
      harnessId: "plugin-runtime",
      harnessAuthBootstrap: "plugin",
      sessionAuthProfileId: "openai:unavailable",
      sessionAuthProfileSource: "user",
      get config(): OpenClawConfig {
        throw new Error("Plugin auth must not inspect shared provider credentials");
      },
      get authProfileStore(): AuthProfileStore {
        throw new Error("Plugin auth must not inspect shared credential profiles");
      },
    });
    const plan = {
      providerForAuth: "openai",
      modelId: "plugin-model",
      authProfileProviderForAuth: "openai",
      harnessAuthProvider: "plugin-runtime",
      credentialSource: { kind: "none" },
    };
    expect(prepared).toEqual({ plan, attempts: [{ kind: "implicit", plan }] });
  });

  it.each([undefined, "openclaw"])("requires a plugin harness for owner %s", (harnessId) => {
    expect(() =>
      prepareAgentRuntimeAuth({
        provider: "openai",
        modelId: "plugin-model",
        harnessId,
        harnessAuthBootstrap: "plugin",
      }),
    ).toThrow("Plugin-owned authentication requires a selected plugin harness");
  });
});
