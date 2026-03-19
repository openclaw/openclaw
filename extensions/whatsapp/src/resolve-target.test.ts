import { describe, expect, it, vi } from "vitest";
import { installCommonResolveTargetErrorCases } from "../../shared/resolve-target-test-helpers.js";

const whatsappMocks = vi.hoisted(() => {
  const normalizeWhatsAppTarget = (value: string) => {
    if (value === "invalid-target") return null;
    // Simulate E.164 normalization: strip leading + and whatsapp: prefix.
    const stripped = value.replace(/^whatsapp:/i, "").replace(/^\+/, "");
    return stripped.includes("@g.us") ? stripped : `${stripped}@s.whatsapp.net`;
  };

  const resolveWhatsAppOutboundTarget = ({
    to,
    allowFrom,
    mode,
  }: {
    to?: string;
    allowFrom: string[];
    mode: "explicit" | "implicit";
  }) => {
    const raw = typeof to === "string" ? to.trim() : "";
    if (!raw) {
      return { ok: false, error: new Error("missing target") };
    }
    const normalized = normalizeWhatsAppTarget(raw);
    if (!normalized) {
      return { ok: false, error: new Error("invalid target") };
    }

    if (mode === "implicit" && !normalized.endsWith("@g.us")) {
      const allowAll = allowFrom.includes("*");
      const allowExact = allowFrom.some((entry) => {
        if (!entry) {
          return false;
        }
        const normalizedEntry = normalizeWhatsAppTarget(entry.trim());
        return normalizedEntry?.toLowerCase() === normalized.toLowerCase();
      });
      if (!allowAll && !allowExact) {
        return { ok: false, error: new Error("target not allowlisted") };
      }
    }

    return { ok: true, to: normalized };
  };

  return {
    normalizeWhatsAppTarget,
    resolveWhatsAppOutboundTarget,
  };
});

vi.mock("openclaw/plugin-sdk/whatsapp", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/whatsapp")>(
    "openclaw/plugin-sdk/whatsapp",
  );

  return {
    ...actual,
    normalizeWhatsAppTarget: whatsappMocks.normalizeWhatsAppTarget,
    isWhatsAppGroupJid: (value: string) => value.endsWith("@g.us"),
  };
});

vi.mock("openclaw/plugin-sdk/whatsapp-core", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/whatsapp-core")>(
    "openclaw/plugin-sdk/whatsapp-core",
  );

  return {
    ...actual,
    getChatChannelMeta: () => ({ id: "whatsapp", label: "WhatsApp" }),
    resolveWhatsAppOutboundTarget: whatsappMocks.resolveWhatsAppOutboundTarget,
    missingTargetError: (provider: string, hint: string) =>
      new Error(`Delivering to ${provider} requires target ${hint}`),
  };
});

vi.mock("./runtime.js", () => ({
  getWhatsAppRuntime: vi.fn(() => ({
    channel: {
      text: { chunkText: vi.fn() },
      whatsapp: {
        sendMessageWhatsApp: vi.fn(),
        createLoginTool: vi.fn(),
      },
    },
  })),
}));

import { whatsappPlugin } from "./channel.js";

const resolveTarget = whatsappPlugin.outbound!.resolveTarget!;

describe("whatsapp resolveTarget", () => {
  it("should resolve valid target in explicit mode", () => {
    const result = resolveTarget({
      to: "5511999999999",
      mode: "explicit",
      allowFrom: [],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw result.error;
    }
    expect(result.to).toBe("5511999999999@s.whatsapp.net");
  });

  it("should resolve target in implicit mode with wildcard", () => {
    const result = resolveTarget({
      to: "5511999999999",
      mode: "implicit",
      allowFrom: ["*"],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw result.error;
    }
    expect(result.to).toBe("5511999999999@s.whatsapp.net");
  });

  it("should resolve target in implicit mode when in allowlist", () => {
    const result = resolveTarget({
      to: "5511999999999",
      mode: "implicit",
      allowFrom: ["5511999999999"],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw result.error;
    }
    expect(result.to).toBe("5511999999999@s.whatsapp.net");
  });

  it("should allow group JID regardless of allowlist", () => {
    const result = resolveTarget({
      to: "120363123456789@g.us",
      mode: "implicit",
      allowFrom: ["5511999999999"],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw result.error;
    }
    expect(result.to).toBe("120363123456789@g.us");
  });

  it("should error when target not in allowlist (implicit mode)", () => {
    const result = resolveTarget({
      to: "5511888888888",
      mode: "implicit",
      allowFrom: ["5511999999999", "5511777777777"],
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected resolution to fail");
    }
    expect(result.error).toBeDefined();
  });

  installCommonResolveTargetErrorCases({
    resolveTarget,
    implicitAllowFrom: ["5511999999999"],
  });
});
