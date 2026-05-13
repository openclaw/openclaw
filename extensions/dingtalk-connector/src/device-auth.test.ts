import { describe, expect, it } from "vitest";
import { renderQrCodeText } from "./device-auth.ts";

// Regression guard for `qrcode-terminal` `this` binding.
//
// `qrcode-terminal`'s `generate` reads `this.error` (QR error-correct level)
// at call time. If we destructure it out of the module namespace the `this`
// context is lost, the error level becomes `undefined`, and `generate` throws
// internally. The implementation catches that, returns `null`, and the
// onboarding wizard silently falls back to URL-only mode.
//
// Keep these tests — a `null` return here means the CLI QR surface is broken.
describe("renderQrCodeText", () => {
  it("renders a non-empty QR block for a typical URL", async () => {
    const out = await renderQrCodeText(
      "https://open-dev.dingtalk.com/openapp/registration/openClaw?user_code=ABCD-1234&source=DING_DWS_CLAW",
    );
    expect(out).not.toBeNull();
    expect(typeof out).toBe("string");
    expect((out as string).length).toBeGreaterThan(0);
    // qrcode-terminal always draws the top and bottom quiet-zone borders with
    // the `▄` and `▀` half-block characters; if `this` binding breaks we fall
    // into the catch branch and return `null`, so these characters never show.
    expect(out).toMatch(/[▀▄█]/u);
  });

  it("stays successful across repeated calls (no hidden module-level state leak)", async () => {
    const first = await renderQrCodeText("https://example.com/a");
    const second = await renderQrCodeText("https://example.com/b");
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    // Different payloads must render different QR matrices.
    expect(first).not.toBe(second);
  });
});
