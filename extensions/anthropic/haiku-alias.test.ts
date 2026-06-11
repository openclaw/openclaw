// Test: verify Haiku 4.5 alias resolution through the real provider model normalization path.
// This exercises the manifest normalization policies (not a custom simulator).

import { describe, expect, it } from "vitest";
import { normalizeStaticProviderModelIdWithPolicies } from "@openclaw/model-catalog-core/provider-model-id-normalization";

// Load the actual manifest from the anthropic extension
import anthropicManifest from "./openclaw.plugin.json" assert { type: "json" };

describe("anthropic haiku 4.5 manifest alias normalization", () => {
  const policies = new Map([
    [
      "anthropic",
      anthropicManifest.modelIdNormalization?.providers?.anthropic ?? {},
    ],
  ]);

  it("normalizes claude-haiku-4-5 rolling ref to dated id", () => {
    const result = normalizeStaticProviderModelIdWithPolicies(
      "anthropic",
      "claude-haiku-4-5",
      policies,
    );
    expect(result).toBe("claude-haiku-4-5-20251001");
  });

  it("normalizes claude-haiku-4.5 dotted ref to dated id", () => {
    const result = normalizeStaticProviderModelIdWithPolicies(
      "anthropic",
      "claude-haiku-4.5",
      policies,
    );
    expect(result).toBe("claude-haiku-4-5-20251001");
  });

  it("normalizes haiku-4.5 short alias to dated id", () => {
    const result = normalizeStaticProviderModelIdWithPolicies(
      "anthropic",
      "haiku-4.5",
      policies,
    );
    expect(result).toBe("claude-haiku-4-5-20251001");
  });

  it("normalizes haiku shortest alias to dated id", () => {
    const result = normalizeStaticProviderModelIdWithPolicies(
      "anthropic",
      "haiku",
      policies,
    );
    expect(result).toBe("claude-haiku-4-5-20251001");
  });

  it("returns prefixed form unchanged when alias is for bare id (existing behavior)", () => {
    const result = normalizeStaticProviderModelIdWithPolicies(
      "anthropic",
      "anthropic/claude-haiku-4-5",
      policies,
    );
    // The alias lookup uses the bare id; prefixed input falls through to built-in normalization.
    expect(result).toBe("claude-haiku-4-5");
  });

  it("preserves already-dated id unchanged", () => {
    const result = normalizeStaticProviderModelIdWithPolicies(
      "anthropic",
      "claude-haiku-4-5-20251001",
      policies,
    );
    expect(result).toBe("claude-haiku-4-5-20251001");
  });
});
