import { describe, expect, it } from "vitest";
import { legacyConfigRules, sessionRouteStateOwners } from "./doctor-contract-api.js";

describe("anthropic doctor contract", () => {
  it("owns Claude CLI session route state for doctor cleanup", () => {
    expect(legacyConfigRules).toEqual([]);
    expect(sessionRouteStateOwners).toEqual([
      {
        id: "anthropic",
        label: "Anthropic",
        providerIds: ["anthropic", "claude-cli"],
        runtimeIds: ["claude-cli"],
        cliSessionKeys: ["claude-cli"],
        authProfilePrefixes: ["anthropic:", "claude-cli:"],
      },
    ]);
  });
});
