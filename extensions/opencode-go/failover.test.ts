// OpenCode Go failover tests keep vendor error policy at its owning plugin boundary.
import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import { beforeAll, describe, expect, it } from "vitest";
import opencodeGoPlugin from "./index.js";

let provider: Awaited<ReturnType<typeof registerSingleProviderPlugin>>;

beforeAll(async () => {
  provider = await registerSingleProviderPlugin(opencodeGoPlugin);
});

function classifyOpencodeGoFailure(errorMessage: string, providerId?: string) {
  return provider.classifyFailoverReason?.({ provider: providerId, errorMessage });
}

const UPSTREAM_REJECTION =
  "400 Error from provider (Console Go): Upstream request failed: [data_inspection_failed] <400> InternalError.Algo.DataInspectionFailed: Input text data may contain inappropriate content.";

describe("OpenCode Go failover classification", () => {
  it.each([
    [UPSTREAM_REJECTION, "overloaded"],
    ["[data_inspection_failed] Input text data may contain inappropriate content.", "overloaded"],
    ["InternalError.Algo.DataInspectionFailed", "overloaded"],
  ] as const)("maps an upstream content-guard rejection to %s", (errorMessage, expected) => {
    expect(classifyOpencodeGoFailure(errorMessage, "opencode-go")).toBe(expected);
  });

  it.each([
    "400 Bad Request: unknown parameter 'reasoning_effort'",
    "invalid_request_error: messages must alternate",
    "429 Your quota has been exhausted",
  ])("leaves genuine request failures to generic classification (%s)", (errorMessage) => {
    expect(classifyOpencodeGoFailure(errorMessage, "opencode-go")).toBeUndefined();
  });

  it.each([undefined, "anthropic", "custom-opencode-go"])(
    "does not apply OpenCode Go policy to provider %s",
    (providerId) => {
      expect(classifyOpencodeGoFailure(UPSTREAM_REJECTION, providerId)).toBeUndefined();
    },
  );
});
