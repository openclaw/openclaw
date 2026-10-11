import { resolveAuthProfileOrder, type AuthProfileStore } from "openclaw/plugin-sdk/provider-auth";
import { describe, expect, it, vi } from "vitest";
import { createCodexAuthProfileSelection } from "./auth-profile-selection.js";

describe("Codex auth profile selection", () => {
  it("selects the configured profile after loading the worker-backed store", async () => {
    const store: AuthProfileStore = {
      version: 1,
      profiles: {
        "openai:work": { type: "token", provider: "openai", token: "work-token" },
      },
    };
    const selection = createCodexAuthProfileSelection({
      ensureAuthProfileStore: vi.fn().mockReturnValue(store),
      ensureAuthProfileStoreAsync: vi.fn().mockResolvedValue(store),
      resolveAuthProfileOrder,
    });

    await expect(
      selection.resolveCodexAppServerAuthProfileIdForAgent({ agentDir: "/agent" }),
    ).resolves.toBe("openai:work");
  });

  it("preserves an explicit profile selection without reopening its store", async () => {
    const ensureAuthProfileStoreAsync = vi.fn().mockRejectedValue(new Error("store unavailable"));
    const selection = createCodexAuthProfileSelection({
      ensureAuthProfileStore: vi.fn(),
      ensureAuthProfileStoreAsync,
      resolveAuthProfileOrder,
    });

    await expect(
      selection.resolveCodexAppServerAuthProfileIdForAgent({ authProfileId: " openai:work " }),
    ).resolves.toBe("openai:work");
    expect(ensureAuthProfileStoreAsync).not.toHaveBeenCalled();
  });
});
