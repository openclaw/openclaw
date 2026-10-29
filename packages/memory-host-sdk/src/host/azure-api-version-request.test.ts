import { expect, it } from "vitest";
import { resolveAzureApiVersionRequestTarget } from "./azure-api-version-request.js";

it.each([
  ["example.openai.azure.com", "", "?api-version=2024-10-21"],
  ["example.services.ai.azure.com", "?api-version=", "?api-version=2024-10-21"],
  ["example.cognitiveservices.azure.com", "?api-version=2023-05-15", "?api-version=2023-05-15"],
])("moves the header into the query for %s", (host, query, expected) => {
  const url = `https://${host}/embeddings`;
  const headers = Object.freeze({ "API-Version": "2024-10-21", "api-key": "test-key" });
  expect(resolveAzureApiVersionRequestTarget({ url: url + query, headers })).toEqual({
    url: url + expected,
    headers: { "api-key": "test-key" },
  });
});

it.each(["api.openai.com", "openai.azure.com.evil.example"])(
  "preserves non-Azure request targets for %s",
  (host) => {
    const request = {
      url: `https://${host}/v1/embeddings`,
      headers: { "api-version": "proxy-version" },
    };
    expect(resolveAzureApiVersionRequestTarget(request)).toBe(request);
  },
);
