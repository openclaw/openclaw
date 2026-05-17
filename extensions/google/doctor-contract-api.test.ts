import { describe, expect, it } from "vitest";
import { sessionRouteStateOwners } from "./doctor-contract-api.js";

describe("google doctor contract", () => {
  it("owns Gemini CLI session route state for doctor cleanup", () => {
    expect(sessionRouteStateOwners).toEqual([
      {
        id: "google",
        label: "Google",
        providerIds: ["google", "google-gemini-cli", "google-vertex"],
        runtimeIds: ["google-gemini-cli"],
        cliSessionKeys: ["google-gemini-cli"],
        authProfilePrefixes: ["google:", "google-gemini-cli:", "google-vertex:"],
      },
    ]);
  });
});
