import type { StreamFn } from "@earendil-works/pi-agent-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { registerProviderStreamForModel } from "./provider-stream.js";
import { createTransportAwareStreamFnForModel } from "./provider-transport-stream.js";

vi.mock("../plugins/provider-runtime.js", () => ({
  resolveProviderStreamFn: vi.fn(() => undefined),
}));

vi.mock("./provider-transport-stream.js", () => ({
  createTransportAwareStreamFnForModel: vi.fn(() => undefined),
}));

const googleGenerativeModel = {
  api: "google-generative-ai",
  provider: "google",
  id: "gemini-3.5-flash",
} as never;

const googleVertexModel = {
  api: "google-vertex",
  provider: "google",
  id: "gemini-3.5-flash",
} as never;

const googleModelResolvedThroughMismatchedProvider = {
  api: "openai-responses",
  provider: "google",
  id: "gemini-3.5-flash",
} as never;

const streamFn = (() => undefined) as unknown as StreamFn;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("registerProviderStreamForModel", () => {
  it("preserves env-only Google Gemini routing when models.providers.google is missing", () => {
    vi.mocked(createTransportAwareStreamFnForModel).mockReturnValueOnce(streamFn);

    expect(() =>
      registerProviderStreamForModel({
        model: googleGenerativeModel,
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
      googleGenerativeModel,
      expect.objectContaining({
        env: expect.objectContaining({
          GEMINI_API_KEY: "google-env-key",
        }),
      }),
    );
  });

  it("fails closed when a Google provider config explicitly points at a non-Google API", () => {
    expect(() =>
      registerProviderStreamForModel({
        model: googleModelResolvedThroughMismatchedProvider,
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
        model: googleModelResolvedThroughMismatchedProvider,
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

  it("allows Google Gemini routing when the Google provider is explicitly configured with the Google API", () => {
    vi.mocked(createTransportAwareStreamFnForModel).mockReturnValueOnce(streamFn);

    expect(() =>
      registerProviderStreamForModel({
        model: googleGenerativeModel,
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

  it("preserves Google Vertex routing when models.providers.google.api is google-vertex", () => {
    vi.mocked(createTransportAwareStreamFnForModel).mockReturnValueOnce(streamFn);

    expect(() =>
      registerProviderStreamForModel({
        model: googleVertexModel,
        cfg: {
          models: {
            providers: {
              google: {
                api: "google-vertex",
              },
            },
          },
        } as OpenClawConfig,
      }),
    ).not.toThrow(/models\.providers\.google/);
  });
});
