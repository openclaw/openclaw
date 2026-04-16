import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { Context, Model } from "@mariozechner/pi-ai";
import { describe, expect, it, vi } from "vitest";

describe("registerGoogleProvider wrapStreamFn", () => {
  it("strips gcp-vertex-credentials marker for google-vertex API models", async () => {
    let registeredProvider: Record<string, unknown> | undefined;
    const fakeApi = {
      registerProvider: (opts: Record<string, unknown>) => {
        registeredProvider = opts;
      },
    };

    const { registerGoogleProvider } = await import("./provider-registration.js");
    registerGoogleProvider(fakeApi as never);

    const wrapStreamFn = registeredProvider?.wrapStreamFn as
      | ((ctx: { model?: { api: string }; streamFn?: StreamFn }) => StreamFn | null | undefined)
      | undefined;

    expect(wrapStreamFn).toBeDefined();

    const vertexModel = { api: "google-vertex" } as Model<"google-vertex">;
    const capturedOptions: unknown[] = [];

    const innerStreamFn: StreamFn = vi.fn((_m, _ctx, options) => {
      capturedOptions.push(options);
      return Promise.resolve({} as never);
    });

    const wrapped = wrapStreamFn!({ model: vertexModel, streamFn: innerStreamFn });
    expect(wrapped).toBeDefined();

    await wrapped!(
      vertexModel,
      {} as Context,
      { apiKey: "gcp-vertex-credentials", model: vertexModel } as never,
    );

    expect(capturedOptions).toHaveLength(1);
    expect((capturedOptions[0] as { apiKey: unknown }).apiKey).toBeUndefined();
  });

  it("passes real apiKey through unchanged for google-vertex API models", async () => {
    let registeredProvider: Record<string, unknown> | undefined;
    const fakeApi = {
      registerProvider: (opts: Record<string, unknown>) => {
        registeredProvider = opts;
      },
    };

    const { registerGoogleProvider } = await import("./provider-registration.js");
    registerGoogleProvider(fakeApi as never);

    const wrapStreamFn = registeredProvider?.wrapStreamFn as
      | ((ctx: { model?: { api: string }; streamFn?: StreamFn }) => StreamFn | null | undefined)
      | undefined;

    const vertexModel = { api: "google-vertex" } as Model<"google-vertex">;
    const capturedOptions: unknown[] = [];

    const innerStreamFn: StreamFn = vi.fn((_m, _ctx, options) => {
      capturedOptions.push(options);
      return Promise.resolve({} as never);
    });

    const wrapped = wrapStreamFn!({ model: vertexModel, streamFn: innerStreamFn });

    await wrapped!(
      vertexModel,
      {} as Context,
      { apiKey: "real-api-key-123", model: vertexModel } as never,
    );

    expect((capturedOptions[0] as { apiKey: unknown }).apiKey).toBe("real-api-key-123");
  });

  it("returns undefined for non-vertex API models", async () => {
    let registeredProvider: Record<string, unknown> | undefined;
    const fakeApi = {
      registerProvider: (opts: Record<string, unknown>) => {
        registeredProvider = opts;
      },
    };

    const { registerGoogleProvider } = await import("./provider-registration.js");
    registerGoogleProvider(fakeApi as never);

    const wrapStreamFn = registeredProvider?.wrapStreamFn as
      | ((ctx: { model?: { api: string }; streamFn?: StreamFn }) => StreamFn | null | undefined)
      | undefined;

    const geminiModel = { api: "google-generative-ai" } as Model<"google-generative-ai">;
    const innerStreamFn: StreamFn = vi.fn();

    const result = wrapStreamFn!({ model: geminiModel, streamFn: innerStreamFn });
    expect(result).toBeUndefined();
  });
});
