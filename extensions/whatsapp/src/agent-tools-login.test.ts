import { beforeEach, describe, expect, it, vi } from "vitest";
import { createWhatsAppLoginTool } from "./agent-tools-login.js";

const hoisted = vi.hoisted(() => ({
  startWebLoginWithQr: vi.fn(),
  waitForWebLogin: vi.fn(),
}));

vi.mock("../login-qr-api.js", () => ({
  startWebLoginWithQr: hoisted.startWebLoginWithQr,
  waitForWebLogin: hoisted.waitForWebLogin,
}));

describe("createWhatsAppLoginTool", () => {
  beforeEach(() => {
    hoisted.startWebLoginWithQr.mockReset();
    hoisted.waitForWebLogin.mockReset();
  });

  it("preserves unstable-auth code on non-QR start results", async () => {
    hoisted.startWebLoginWithQr.mockResolvedValueOnce({
      code: "whatsapp-auth-unstable",
      message: "WhatsApp auth state is still stabilizing. Retry login in a moment.",
    });

    const tool = createWhatsAppLoginTool();
    const result = await tool.execute("tool-call", {
      action: "start",
      timeoutMs: 5_000,
    });

    expect(hoisted.startWebLoginWithQr).toHaveBeenCalledWith({
      timeoutMs: 5_000,
      force: false,
    });
    expect(result).toEqual({
      content: [
        {
          type: "text",
          text: "WhatsApp auth state is still stabilizing. Retry login in a moment.",
        },
      ],
      details: { qr: false, code: "whatsapp-auth-unstable" },
    });
  });

  it("returns QR details without adding an unstable code", async () => {
    hoisted.startWebLoginWithQr.mockResolvedValueOnce({
      qrDataUrl: "data:image/png;base64,abc123",
      message: "QR already active. Scan it in WhatsApp -> Linked Devices.",
    });

    const tool = createWhatsAppLoginTool();
    const result = await tool.execute("tool-call", {
      action: "start",
      force: true,
    });

    expect(result).toEqual({
      content: [
        {
          type: "text",
          text: [
            "QR already active. Scan it in WhatsApp -> Linked Devices.",
            "",
            "Open WhatsApp → Linked Devices and scan:",
            "",
            "![whatsapp-qr](data:image/png;base64,abc123)",
          ].join("\n"),
        },
      ],
      details: { qr: true },
    });
  });
});
