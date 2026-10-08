import { ProviderHttpError } from "openclaw/plugin-sdk/provider-http";
import { describe, expect, it } from "vitest";
import { annotateDirectImageAuthFailure } from "./image-generation-diagnostics.js";

const baseParams = {
  url: "https://proxy.example.test/v1/images/edits?token=secret",
  authMode: "api-key",
  authOverridden: false,
  oauthAvailable: false,
};

describe("annotateDirectImageAuthFailure", () => {
  it("names the route without query string or OAuth hint", () => {
    const error = new ProviderHttpError("OpenAI image edit failed (HTTP 403)", { status: 403 });
    annotateDirectImageAuthFailure(error, baseParams);
    expect(error.message).toBe(
      "OpenAI image edit failed (HTTP 403) " +
        "(route=images-api url=https://proxy.example.test/v1/images/edits credential=api-key source=unknown)",
    );
    expect(error.status).toBe(403);
  });

  it("attributes overridden credentials to provider config without header values", () => {
    const error = new ProviderHttpError("OpenAI image generation failed (HTTP 401)", {
      status: 401,
    });
    annotateDirectImageAuthFailure(error, {
      ...baseParams,
      authMode: "oauth",
      authSource: "profile:openai:chatgpt",
      authOverridden: true,
    });
    expect(error.message).toContain("credential=configured-header source=models.providers.openai)");
    expect(error.message).not.toContain("profile:openai:chatgpt");
  });

  it.each([
    ["429 responses", new ProviderHttpError("rate limited", { status: 429 })],
    ["errors without status", new Error("network down")],
  ])("leaves %s unchanged", (_label, error) => {
    const message = error.message;
    annotateDirectImageAuthFailure(error, { ...baseParams, oauthAvailable: true });
    expect(error.message).toBe(message);
  });
});
