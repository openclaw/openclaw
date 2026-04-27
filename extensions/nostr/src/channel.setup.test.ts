import { describe, expect, it, vi } from "vitest";
import { nostrSetupPlugin } from "./channel.setup.js";
import { DEFAULT_RELAYS } from "./default-relays.js";

vi.mock("./setup-surface.js", () => {
  throw new Error("full Nostr setup surface should stay unloaded during setup status checks");
});

describe("nostr setup-only plugin", () => {
  function getStatus() {
    const wizard = nostrSetupPlugin.setupWizard;
    if (!wizard || !("status" in wizard)) {
      throw new Error("nostr setup wizard status missing");
    }
    return wizard.status;
  }

  it("resolves setup status without loading the full setup surface", async () => {
    const status = getStatus();

    expect(await status.resolveConfigured({ cfg: {} })).toBe(false);
    expect(await status.resolveStatusLines?.({ cfg: {}, configured: false })).toEqual([
      "Nostr: needs private key",
      `Relays: ${DEFAULT_RELAYS.length}`,
    ]);
  });

  it("reports configured state from lightweight config inspection", async () => {
    const status = getStatus();

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
