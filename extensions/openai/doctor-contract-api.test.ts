import { describe, expect, it } from "vitest";
import { legacyConfigRules, sessionRouteStateOwners } from "./doctor-contract-api.js";

describe("OpenAI doctor contract", () => {
  it("claims canonical OpenAI session route state for doctor cleanup", () => {
    expect(legacyConfigRules).toStrictEqual([]);
    expect(sessionRouteStateOwners).toStrictEqual([
      {
        id: "openai",
        label: "OpenAI",
        providerIds: ["openai"],
        authProfilePrefixes: ["openai:"],
      },
    ]);
  });
});
