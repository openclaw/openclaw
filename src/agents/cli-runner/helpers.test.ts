import { describe, expect, it } from "vitest";
import type { CliBackendConfig } from "../../config/types.js";
import { parseCliJson } from "./helpers.js";

const backend = {} as CliBackendConfig;

describe("parseCliJson usage normalization", () => {
  it("maps Anthropic cache_creation_input_tokens to cacheWrite", () => {
    const out = parseCliJson(
      JSON.stringify({
        message: { text: "ok" },
        usage: {
          input_tokens: 120,
          output_tokens: 30,
          cache_creation_input_tokens: 45,
          cache_read_input_tokens: 10,
        },
      }),
      backend,
    );

    expect(out?.usage).toEqual({
      input: 120,
      output: 30,
      cacheRead: 10,
      cacheWrite: 45,
      total: undefined,
    });
  });
});
