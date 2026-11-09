import { ProviderHttpError } from "openclaw/plugin-sdk/provider-http";
import { describe, expect, it } from "vitest";
import { annotateDirectImageAuthFailure } from "./image-generation-diagnostics.js";

const baseParams = {
  url: "https://proxy.example.test/v1/images/edits?token=secret",
  authMode: "api-key",
  authOverridden: false,
  explicitDirectRoute: false,
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

  it("leaves errors without status unchanged", () => {
    const error = new Error("network down");
    const message = error.message;
    annotateDirectImageAuthFailure(error, { ...baseParams, explicitDirectRoute: true });
    expect(error.message).toBe(message);
  });
});
