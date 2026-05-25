import type { StreamFn } from "@earendil-works/pi-agent-core";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { registerProviderStreamForModel } from "./provider-stream.js";
import { createTransportAwareStreamFnForModel } from "./provider-transport-stream.js";

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

const streamFn = (() => undefined) as unknown as StreamFn;

describe("registerProviderStreamForModel", () => {
  it("preserves env-only Google Generative AI routing when models.providers.google is missing", () => {
    vi.mocked(createTransportAwareStreamFnForModel).mockReturnValueOnce(streamFn);

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
        env: {
          GEMINI_API_KEY: "google-env-key",
        } as NodeJS.ProcessEnv,
      }),
    ).not.toThrow();
    expect(createTransportAwareStreamFnForModel).toHaveBeenCalledWith(
      googleModel,
      expect.objectContaining({
        env: expect.objectContaining({
          GEMINI_API_KEY: "google-env-key",
        }),
      }),
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
    ).toThrow(/models\.providers\.google api "openai-responses"/);
  });

  it("does not include configured API keys in the mismatched Google provider error", () => {
    const secret = "sk-google-secret-that-must-not-leak";

    try {
      registerProviderStreamForModel({
        model: googleModel,
        cfg: {
          models: {
            providers: {
              google: {
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
    vi.mocked(createTransportAwareStreamFnForModel).mockReturnValueOnce(streamFn);

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
