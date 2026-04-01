import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mediaRuntimeMocks = vi.hoisted(() => ({
  buildProviderRegistry: vi.fn(() => new Map()),
  createMediaAttachmentCache: vi.fn(() => ({
    cleanup: vi.fn(async () => {}),
  })),
  normalizeMediaAttachments: vi.fn(() => [
    {
      index: 0,
      path: "/tmp/local.wav",
    },
  ]),
  normalizeMediaProviderId: vi.fn((id: string) => id),
  runCapability: vi.fn(async () => ({
    outputs: [
      {
        kind: "audio.transcription",
        text: "hello from executorch",
        provider: "executorch",
        model: "parakeet-tdt-0.6b-v3",
      },
    ],
  })),
}));

const pluginRuntimeMocks = vi.hoisted(() => ({
  getPluginMediaProviders: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/media-runtime", () => ({
  buildProviderRegistry: mediaRuntimeMocks.buildProviderRegistry,
  createMediaAttachmentCache: mediaRuntimeMocks.createMediaAttachmentCache,
  normalizeMediaAttachments: mediaRuntimeMocks.normalizeMediaAttachments,
  normalizeMediaProviderId: mediaRuntimeMocks.normalizeMediaProviderId,
  runCapability: mediaRuntimeMocks.runCapability,
}));

vi.mock("openclaw/plugin-sdk/plugin-runtime", () => ({
  getPluginMediaProviders: () => pluginRuntimeMocks.getPluginMediaProviders(),
}));

import { runMediaUnderstandingFile } from "./runtime.js";

describe("runMediaUnderstandingFile", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mediaRuntimeMocks.buildProviderRegistry.mockReturnValue(new Map());
    mediaRuntimeMocks.createMediaAttachmentCache.mockReturnValue({
      cleanup: vi.fn(async () => {}),
    });
    mediaRuntimeMocks.normalizeMediaAttachments.mockReturnValue([
      {
        index: 0,
        path: "/tmp/local.wav",
      },
    ]);
    mediaRuntimeMocks.runCapability.mockResolvedValue({
      outputs: [
        {
          kind: "audio.transcription",
          text: "hello from executorch",
          provider: "executorch",
          model: "parakeet-tdt-0.6b-v3",
        },
      ],
    });
    pluginRuntimeMocks.getPluginMediaProviders.mockReset();
    pluginRuntimeMocks.getPluginMediaProviders.mockReturnValue(undefined);
  });

  it("threads plugin media providers into the runtime registry", async () => {
    const providers = {
      executorch: {
        id: "executorch",
      },
    };
    const cfg = {} as OpenClawConfig;
    pluginRuntimeMocks.getPluginMediaProviders.mockReturnValue(providers);

    const result = await runMediaUnderstandingFile({
      capability: "audio",
      filePath: "/tmp/local.wav",
      cfg,
    });

    expect(mediaRuntimeMocks.buildProviderRegistry).toHaveBeenCalledWith(providers, cfg);
    expect(result).toMatchObject({
      text: "hello from executorch",
      provider: "executorch",
      model: "parakeet-tdt-0.6b-v3",
    });
  });
});
