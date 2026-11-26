import type { CopilotClient } from "@github/copilot-sdk";
import { describe, expect, it, vi } from "vitest";
import { createCopilotAgentHarness } from "../harness.js";
import { tokenFingerprint } from "./auth-bridge.js";
import { createCopilotClientPool } from "./runtime.js";

const { resolveAuth, missingAuth } = vi.hoisted(() => ({
  resolveAuth: vi.fn(),
  missingAuth: Object.assign(new Error("No provider credential"), {
    code: "missing-provider-auth",
    providerGuidance: false,
  }),
}));
// mock-isolation: Native discovery receives a fixture-owned account credential.
vi.mock("openclaw/plugin-sdk/provider-auth-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/provider-auth-runtime")>()),
  resolveApiKeyForProvider: resolveAuth,
}));

const scope = {
  config: {},
  agentId: "test",
  agentDir: "/tmp/copilot-catalog-test",
  workspaceDir: "/workspace",
};

function fixture() {
  const list = vi.fn();
  const start = vi.fn().mockResolvedValue(undefined);
  const stop = vi.fn().mockResolvedValue([]);
  const sdkFactory = vi
    .fn()
    .mockReturnValue({ start, stop, rpc: { models: { list } } } as unknown as CopilotClient);
  const pool = createCopilotClientPool({ sdkFactory });
  const release = vi.spyOn(pool, "release");
  const harness = createCopilotAgentHarness({ pool });
  resolveAuth.mockResolvedValue({ apiKey: "catalog-token", profileId: "github-copilot:test" });
  return { list, start, stop, sdkFactory, pool, release, harness };
}

describe("Copilot native model catalog", () => {
  it("does not acquire GitHub discovery for scoped BYOK models", async () => {
    const f = fixture();
    resolveAuth.mockClear();
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        await expect(
          f.harness.loadModelCatalog!({ ...scope, providerIds: ["custom"] }),
        ).resolves.toEqual([]);
      }
      expect(resolveAuth).not.toHaveBeenCalled();
      expect(f.sdkFactory).not.toHaveBeenCalled();
    } finally {
      await f.harness.dispose?.();
      await f.pool.dispose();
    }
  });

  it("discovers account-enabled Fusion tiers through the SDK catalog", async () => {
    const f = fixture();
    f.list.mockImplementation(async () => {
      expect(f.start).toHaveBeenCalledOnce();
      return {
        models: [
          {
            id: "fixture-chat",
            name: "Fixture chat",
            capabilities: {
              supports: { vision: true, reasoningEffort: true },
              limits: { max_context_window_tokens: 65536 },
            },
          },
          {
            id: "fixture-disabled",
            name: "Disabled",
            capabilities: {},
            policy: { state: "disabled" },
          },
        ],
        auto: {
          defaultTier: "quality",
          tiers: [
            { id: "fast", fusionTier: "standard", status: { enabled: true } },
            { id: "quality", fusionTier: "high", status: { enabled: true } },
            { id: "hidden", fusionTier: "max", status: { enabled: true, pickerVisible: false } },
          ],
        },
      };
    });
    try {
      await expect(f.harness.loadModelCatalog!(scope)).resolves.toEqual({
        entries: [
          {
            id: "fixture-chat",
            name: "Fixture chat",
            provider: "github-copilot",
            nativeRuntime: "copilot",
            input: ["text", "image"],
            reasoning: true,
            contextWindow: 65536,
          },
          {
            id: "fusion",
            name: "Copilot Fusion",
            provider: "github-copilot",
            nativeRuntime: "copilot",
          },
        ],
        outcomes: [
          {
            provider: "github-copilot",
            profileId: "github-copilot:test",
            status: "ready",
            listedModelIds: ["fixture-chat", "fusion"],
          },
        ],
      });
      expect(f.sdkFactory).toHaveBeenCalledWith(
        expect.objectContaining({ gitHubToken: "catalog-token", useLoggedInUser: false }),
      );
      expect(f.release).toHaveBeenCalledWith(
        expect.objectContaining({
          key: expect.objectContaining({
            authProfileId: "github-copilot:test",
            authProfileVersion: tokenFingerprint("catalog-token"),
          }),
        }),
      );
    } finally {
      await f.harness.dispose?.();
      await f.pool.dispose();
    }
  });

  it("keeps empty discovery authoritative and failures scoped to GitHub Copilot", async () => {
    const f = fixture();
    f.list.mockResolvedValueOnce({
      models: [],
      auto: {
        defaultTier: "denied",
        tiers: [{ id: "denied", fusionTier: "max", status: { enabled: false } }],
      },
    });
    try {
      await expect(f.harness.loadModelCatalog!(scope)).resolves.toEqual({
        entries: [],
        outcomes: [
          {
            provider: "github-copilot",
            profileId: "github-copilot:test",
            status: "ready",
            listedModelIds: [],
          },
        ],
      });
      f.list.mockRejectedValueOnce(new Error("catalog unavailable"));
      await expect(f.harness.loadModelCatalog!(scope)).resolves.toEqual({
        entries: [],
        outcomes: [{ provider: "github-copilot", status: "unavailable" }],
      });
      expect(f.release).toHaveBeenCalledTimes(2);
    } finally {
      await f.harness.dispose?.();
      await f.pool.dispose();
    }
  });

  it("does not publish native models without host authentication", async () => {
    const f = fixture();
    resolveAuth.mockRejectedValue(missingAuth);
    try {
      await expect(f.harness.loadModelCatalog!(scope)).resolves.toEqual({
        entries: [],
        outcomes: [{ provider: "github-copilot", status: "unavailable" }],
      });
      expect(f.sdkFactory).not.toHaveBeenCalled();
    } finally {
      await f.harness.dispose?.();
      await f.pool.dispose();
    }
  });

  it("releases a client that finishes acquisition after the discovery timeout", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const f = fixture();
    let finish!: (value: CopilotClient) => void;
    f.sdkFactory.mockImplementationOnce(
      () =>
        new Promise<CopilotClient>((resolve) => {
          finish = resolve;
        }),
    );
    const discovery = f.harness.loadModelCatalog!(scope);
    const unavailable = expect(discovery).resolves.toEqual({
      entries: [],
      outcomes: [{ provider: "github-copilot", status: "unavailable" }],
    });
    try {
      await vi.waitFor(() => expect(f.sdkFactory).toHaveBeenCalledOnce());
      await vi.advanceTimersByTimeAsync(30_000);
      await unavailable;
      finish({ start: f.start, stop: f.stop } as unknown as CopilotClient);
      await vi.waitFor(() => expect(f.release).toHaveBeenCalledOnce());
      expect(f.start).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
      await f.harness.dispose?.();
      await f.pool.dispose();
    }
  });
});
