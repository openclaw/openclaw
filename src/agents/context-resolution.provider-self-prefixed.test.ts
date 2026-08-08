// Regression coverage for #116010: gateway-routed refs arrive provider-self-prefixed
// (`kilocode/kilo-auto/balanced` under provider `kilocode`) while config keys the bare
// id, so the configured context budget missed and sessions silently fell back to the
// provider's discovered window (128k). These tests also pin the lookup precedence the
// bare-id retry must not disturb.
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  ANTHROPIC_SONNET_5_CONTEXT_TOKENS,
  resolveContextTokensForModelFromCache,
} from "./context-resolution.js";

const DISCOVERED_WINDOW = 128_000;
const CONFIGURED_TOKENS = 900_000;

type ModelEntry = { id: string; contextTokens?: number; contextWindow?: number };

function configWith(
  providerId: string,
  providerEntry: { models?: ModelEntry[]; contextTokens?: number; contextWindow?: number },
): OpenClawConfig {
  return { models: { providers: { [providerId]: providerEntry } } } as unknown as OpenClawConfig;
}

// Mirrors the runtime shape: the gateway's catalog only knows the provider default
// window, which is exactly what used to win when the configured lookup missed.
function resolve(
  params: {
    cfg?: OpenClawConfig;
    sourceCfg?: OpenClawConfig | null;
    provider: string;
    model: string;
  },
  discoveredWindow: number | undefined = DISCOVERED_WINDOW,
) {
  return resolveContextTokensForModelFromCache(
    params,
    () => undefined,
    () => discoveredWindow,
  );
}

describe("resolveContextTokensForModelFromCache - provider-self-prefixed refs", () => {
  it("resolves configured contextTokens when the ref repeats its provider prefix", () => {
    const cfg = configWith("kilocode", {
      models: [{ id: "kilo-auto/balanced", contextTokens: CONFIGURED_TOKENS }],
    });

    expect(resolve({ cfg, provider: "kilocode", model: "kilocode/kilo-auto/balanced" })).toBe(
      CONFIGURED_TOKENS,
    );
  });

  it("still resolves when the ref is not self-prefixed", () => {
    const cfg = configWith("kilocode", {
      models: [{ id: "kilo-auto/balanced", contextTokens: CONFIGURED_TOKENS }],
    });

    expect(resolve({ cfg, provider: "kilocode", model: "kilo-auto/balanced" })).toBe(
      CONFIGURED_TOKENS,
    );
  });

  it("prefers the provider-qualified entry over the bare-id entry", () => {
    // Precedence guard: the retry is a fallback, so an author who keyed the fully
    // qualified id must keep winning over a bare entry for the same model.
    const cfg = configWith("kilocode", {
      models: [
        { id: "kilo-auto/balanced", contextTokens: 111_000 },
        { id: "kilocode/kilo-auto/balanced", contextTokens: CONFIGURED_TOKENS },
      ],
    });

    expect(resolve({ cfg, provider: "kilocode", model: "kilocode/kilo-auto/balanced" })).toBe(
      CONFIGURED_TOKENS,
    );
  });

  it("keeps provider-level config ahead of the bare-id model retry", () => {
    // Unchanged precedence: the qualified pass already falls through to the
    // provider-level value, so the retry must never reach past it.
    const cfg = configWith("kilocode", {
      contextTokens: CONFIGURED_TOKENS,
      models: [{ id: "kilo-auto/balanced", contextTokens: 111_000 }],
    });

    expect(resolve({ cfg, provider: "kilocode", model: "kilocode/kilo-auto/balanced" })).toBe(
      CONFIGURED_TOKENS,
    );
  });

  it("applies the retry to the source-config pass as well", () => {
    // Only an authored contextWindow may lower a fixed provider contract, and it is
    // read from the source pass alone - so this is where the second retry earns its
    // keep. Self-prefixed anthropic ref against its fixed 1M window, no discovered
    // window so nothing else can cap the result.
    const authored = configWith("anthropic", {
      models: [{ id: "claude-sonnet-5", contextWindow: 400_000 }],
    });

    expect(
      resolve(
        {
          cfg: authored,
          sourceCfg: authored,
          provider: "anthropic",
          model: "anthropic/claude-sonnet-5",
        },
        undefined,
      ),
    ).toBe(400_000);

    // Same runtime config, but nothing authored in the source snapshot: the fixed
    // contract stands. Proves the 400k above came from the source pass.
    expect(
      resolve(
        {
          cfg: authored,
          sourceCfg: null,
          provider: "anthropic",
          model: "anthropic/claude-sonnet-5",
        },
        undefined,
      ),
    ).toBe(ANTHROPIC_SONNET_5_CONTEXT_TOKENS);
  });

  it("does not strip a prefix belonging to a different provider", () => {
    // `openrouter/...` under provider `kilocode` is a real cross-provider ref, not a
    // self-prefix - stripping it would let one provider inherit another's config.
    const cfg = configWith("kilocode", {
      models: [{ id: "anthropic/claude-sonnet-5", contextTokens: CONFIGURED_TOKENS }],
    });

    expect(
      resolve({ cfg, provider: "kilocode", model: "openrouter/anthropic/claude-sonnet-5" }),
    ).toBe(DISCOVERED_WINDOW);
  });

  it("falls back to the discovered window when nothing is configured", () => {
    const cfg = configWith("kilocode", { models: [] });

    expect(resolve({ cfg, provider: "kilocode", model: "kilocode/kilo-auto/balanced" })).toBe(
      DISCOVERED_WINDOW,
    );
  });
});
