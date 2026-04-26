import { describe, expect, it, vi } from "vitest";
import { nostrSetupPlugin } from "./channel.setup.js";

vi.mock("./setup-surface.js", () => {
  throw new Error("full Nostr setup surface should stay unloaded during setup status checks");
});

describe("nostr setup-only plugin", () => {
  it("resolves setup status without loading the full setup surface", async () => {
    const status = nostrSetupPlugin.setupWizard?.status;
    expect(status).toBeDefined();
    if (!status) {
      throw new Error("nostr setup wizard status missing");
    }

    expect(await status.resolveConfigured({ cfg: {} })).toBe(false);
    expect(await status.resolveStatusLines?.({ cfg: {}, configured: false })).toEqual([
      "Nostr: needs private key",
      "Relays: 2",
    ]);
  });

  it("reports configured state from lightweight config inspection", async () => {
    const status = nostrSetupPlugin.setupWizard?.status;
    if (!status) {
      throw new Error("nostr setup wizard status missing");
    }

    expect(
      await status.resolveConfigured({
        cfg: {
          channels: {
            nostr: {
              privateKey: "0".repeat(64),
            },
          },
        },
      }),
    ).toBe(true);
  });
});
