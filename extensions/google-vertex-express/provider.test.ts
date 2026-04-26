import { describe, expect, it } from "vitest";
import { buildVertexExpressUrl, createVertexExpressTransportStreamFn } from "./transport.js";
import {
  VERTEX_EXPRESS_BASE_URL,
  VERTEX_EXPRESS_DEFAULT_MODEL_REF,
  VERTEX_EXPRESS_MODELS,
  VERTEX_EXPRESS_PROVIDER_ID,
  applyVertexExpressModelDefault,
} from "./onboard.js";

// ---------------------------------------------------------------------------
// URL construction
// ---------------------------------------------------------------------------

describe("buildVertexExpressUrl", () => {
  it("builds the correct publisher-path URL for a simple model id", () => {
    const url = buildVertexExpressUrl("gemini-2.5-pro", "test-key-123");
    expect(url).toBe(
      "https://aiplatform.googleapis.com/v1/publishers/google/models/gemini-2.5-pro:streamGenerateContent?key=test-key-123&alt=sse",
    );
  });

  it("encodes special characters in the API key", () => {
    const url = buildVertexExpressUrl("gemini-2.5-flash", "key+with=special&chars");
    expect(url).toContain("key=key%2Bwith%3Dspecial%26chars");
  });

  it("does not double-prefix a model already starting with publishers/", () => {
    const url = buildVertexExpressUrl(
      "publishers/google/models/gemini-2.5-pro",
      "test-key",
    );
    expect(url).toContain("publishers/google/models/gemini-2.5-pro:streamGenerateContent");
    // Should not have double publishers/google/models prefix
    expect(url).not.toContain(
      "publishers/google/models/publishers/google/models",
    );
  });

  it("uses the correct base URL", () => {
    const url = buildVertexExpressUrl("gemini-3-flash-preview", "key");
    expect(url).toMatch(/^https:\/\/aiplatform\.googleapis\.com\/v1\//);
  });
});

// ---------------------------------------------------------------------------
// Model catalog
// ---------------------------------------------------------------------------

describe("VERTEX_EXPRESS_MODELS", () => {
  it("contains exactly 7 models", () => {
    expect(VERTEX_EXPRESS_MODELS).toHaveLength(7);
  });

  it("has the correct model ids in order", () => {
    const ids = VERTEX_EXPRESS_MODELS.map((m) => m.id);
    expect(ids).toEqual([
      "gemini-3.1-flash-lite-preview",
      "gemini-3.1-pro-preview",
      "gemini-3-flash-preview",
      "gemini-3-pro-preview",
      "gemini-2.5-pro",
      "gemini-2.5-flash",
      "gemini-2.5-flash-lite",
    ]);
  });

  it("has labels matching the spec", () => {
    expect(VERTEX_EXPRESS_MODELS[0].label).toBe("Gemini 3.1 Flash-Lite (Preview)");
    expect(VERTEX_EXPRESS_MODELS[1].label).toBe("Gemini 3.1 Pro (Preview)");
    expect(VERTEX_EXPRESS_MODELS[4].label).toBe("Gemini 2.5 Pro");
    expect(VERTEX_EXPRESS_MODELS[6].label).toBe("Gemini 2.5 Flash-Lite");
  });
});

// ---------------------------------------------------------------------------
// Default model ref
// ---------------------------------------------------------------------------

describe("VERTEX_EXPRESS_DEFAULT_MODEL_REF", () => {
  it("is the provider-qualified ref for the first model", () => {
    expect(VERTEX_EXPRESS_DEFAULT_MODEL_REF).toBe(
      `${VERTEX_EXPRESS_PROVIDER_ID}/gemini-3.1-flash-lite-preview`,
    );
  });
});

// ---------------------------------------------------------------------------
// applyVertexExpressModelDefault
// ---------------------------------------------------------------------------

describe("applyVertexExpressModelDefault", () => {
  it("sets the primary model when none is configured", () => {
    const { next, changed } = applyVertexExpressModelDefault({});
    expect(changed).toBe(true);
    const primary = (next.agents?.defaults?.model as { primary?: string })?.primary;
    expect(primary).toBe(
      `${VERTEX_EXPRESS_PROVIDER_ID}/gemini-3.1-flash-lite-preview`,
    );
  });

  it("is idempotent when already set to the same model", () => {
    const initial: Record<string, unknown> = {
      agents: {
        defaults: {
          model: {
            primary: `${VERTEX_EXPRESS_PROVIDER_ID}/gemini-3.1-flash-lite-preview`,
          },
        },
      },
    };
    const { changed } = applyVertexExpressModelDefault(initial as never);
    expect(changed).toBe(false);
  });

  it("respects a custom modelId argument", () => {
    const { next, changed } = applyVertexExpressModelDefault({}, "gemini-2.5-pro");
    expect(changed).toBe(true);
    const primary = (next.agents?.defaults?.model as { primary?: string })?.primary;
    expect(primary).toBe(`${VERTEX_EXPRESS_PROVIDER_ID}/gemini-2.5-pro`);
  });
});

// ---------------------------------------------------------------------------
// StreamFn factory — smoke-check
// ---------------------------------------------------------------------------

describe("createVertexExpressTransportStreamFn", () => {
  it("returns a function", () => {
    const fn = createVertexExpressTransportStreamFn();
    expect(typeof fn).toBe("function");
  });
});
