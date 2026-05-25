import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { registerProviderStreamForModel } from "./provider-stream.js";

vi.mock("../plugins/provider-runtime.js", () => ({
  resolveProviderStreamFn: vi.fn(() => undefined),
}));

vi.mock("./provider-transport-stream.js", () => ({
  createTransportAwareStreamFnForModel: vi.fn(() => undefined),
}));

const googleModel = {
  api: "google-generative-ai",
  provider: "google",
  id: "gemini-3.5-flash",
} as never;

describe("registerProviderStreamForModel", () => {
  it("fails closed for Google Generative AI models when models.providers.google is missing", () => {
    expect(() =>
      registerProviderStreamForModel({
        model: googleModel,
        cfg: {
          models: {
            providers: {
              openai: {
                api: "openai-responses",
                apiKey: "openai-key",
              },
            },
          },
        } as OpenClawConfig,
      }),
    ).toThrow(/models\.providers\.google/);
  });

  it("fails closed before a Google model can fall through to an OpenAI provider config", () => {
    expect(() =>
      registerProviderStreamForModel({
        model: googleModel,
        cfg: {
          agents: {
            defaults: {
              model: {
                primary: "openai/gpt-5.5",
                fallbacks: ["google/gemini-3.5-flash"],
              },
            },
          },
          models: {
            providers: {
              openai: {
                api: "openai-responses",
                apiKey: "openai-key",
              },
            },
          },
        } as OpenClawConfig,
      }),
    ).toThrow(
      /Google model "google\/gemini-3\.5-flash" requires models\.providers\.google with api "google-generative-ai"/,
    );
  });

  it("fails closed when models.providers.google is configured with a non-Google API", () => {
    expect(() =>
      registerProviderStreamForModel({
        model: googleModel,
        cfg: {
          models: {
            providers: {
              google: {
                api: "openai-responses",
                apiKey: "google-key",
              },
            },
          },
        } as OpenClawConfig,
      }),
    ).toThrow(/api "google-generative-ai"/);
  });

  it("does not include configured API keys in the missing Google provider error", () => {
    const secret = "sk-openai-secret-that-must-not-leak";

    try {
      registerProviderStreamForModel({
        model: googleModel,
        cfg: {
          models: {
            providers: {
              openai: {
                api: "openai-responses",
                apiKey: secret,
              },
            },
          },
        } as OpenClawConfig,
      });
      throw new Error("expected registerProviderStreamForModel to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).not.toContain(secret);
    }
  });

  it("allows Google Generative AI models when the Google provider is explicitly configured", () => {
    expect(() =>
      registerProviderStreamForModel({
        model: googleModel,
        cfg: {
          models: {
            providers: {
              Google: {
                api: "google-generative-ai",
                apiKey: "google-key",
              },
            },
          },
        } as OpenClawConfig,
      }),
    ).not.toThrow(/models\.providers\.google/);
  });
});
