import { installCommonResolveTargetErrorCases } from "openclaw/plugin-sdk/testing";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
	isWhatsAppGroupJid,
	isWhatsAppUserTarget,
	normalizeWhatsAppTarget,
} from "./normalize-target.js";

vi.mock("./runtime-api.js", async () => {
	const actual =
		await vi.importActual<typeof import("./runtime-api.js")>(
			"./runtime-api.js",
		);
	const normalizeWhatsAppTarget = (value: string) => {
		if (value === "invalid-target") return null;
		// Simulate E.164 normalization: strip leading + and whatsapp: prefix.
		const stripped = value.replace(/^whatsapp:/i, "").replace(/^\+/, "");
		return stripped.includes("@g.us") ? stripped : `${stripped}@s.whatsapp.net`;
	};

	return {
		...actual,
		getChatChannelMeta: () => ({ id: "whatsapp", label: "WhatsApp" }),
		normalizeWhatsAppTarget,
		isWhatsAppGroupJid: (value: string) => value.endsWith("@g.us"),
		resolveWhatsAppOutboundTarget: ({
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
		},
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

let resolveTarget: NonNullable<
	NonNullable<
		NonNullable<
			typeof import("./channel.js").whatsappPlugin.outbound
		>["resolveTarget"]
	>
>;

describe("whatsapp resolveTarget", () => {
	beforeAll(async () => {
		vi.resetModules();
		const outbound = (await import("./channel.js")).whatsappPlugin.outbound;
		if (!outbound?.resolveTarget) {
			throw new Error("expected whatsapp outbound resolveTarget");
		}
		resolveTarget = outbound.resolveTarget;
	});

	beforeEach(() => {
		vi.clearAllMocks();
	});

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

	describe("common error cases", () => {
		installCommonResolveTargetErrorCases({
			resolveTarget: (...args) => resolveTarget(...args),
			implicitAllowFrom: ["5511999999999"],
		});
	});
});

describe("normalizeWhatsAppTarget", () => {
	it("preserves group JIDs", () => {
		expect(normalizeWhatsAppTarget("120363401234567890@g.us")).toBe(
			"120363401234567890@g.us",
		);
		expect(normalizeWhatsAppTarget("123456789-987654321@g.us")).toBe(
			"123456789-987654321@g.us",
		);
		expect(normalizeWhatsAppTarget("whatsapp:120363401234567890@g.us")).toBe(
			"120363401234567890@g.us",
		);
	});

	it("normalizes direct JIDs to E.164", () => {
		expect(normalizeWhatsAppTarget("1555123@s.whatsapp.net")).toBe("+1555123");
	});

	it("normalizes user JIDs with device suffix to E.164", () => {
		expect(normalizeWhatsAppTarget("41796666864:0@s.whatsapp.net")).toBe(
			"+41796666864",
		);
		expect(normalizeWhatsAppTarget("1234567890:123@s.whatsapp.net")).toBe(
			"+1234567890",
		);
		expect(normalizeWhatsAppTarget("41796666864@s.whatsapp.net")).toBe(
			"+41796666864",
		);
	});

	it("normalizes LID JIDs to E.164", () => {
		expect(normalizeWhatsAppTarget("123456789@lid")).toBe("+123456789");
		expect(normalizeWhatsAppTarget("123456789@LID")).toBe("+123456789");
	});

	it("rejects invalid targets", () => {
		expect(normalizeWhatsAppTarget("wat")).toBeNull();
		expect(normalizeWhatsAppTarget("whatsapp:")).toBeNull();
		expect(normalizeWhatsAppTarget("@g.us")).toBeNull();
		expect(normalizeWhatsAppTarget("whatsapp:group:@g.us")).toBeNull();
		expect(
			normalizeWhatsAppTarget("whatsapp:group:120363401234567890@g.us"),
		).toBeNull();
		expect(
			normalizeWhatsAppTarget("group:123456789-987654321@g.us"),
		).toBeNull();
		expect(
			normalizeWhatsAppTarget(" WhatsApp:Group:123456789-987654321@G.US "),
		).toBeNull();
		expect(normalizeWhatsAppTarget("abc@s.whatsapp.net")).toBeNull();
	});

	it("handles repeated prefixes", () => {
		expect(normalizeWhatsAppTarget("whatsapp:whatsapp:+1555")).toBe("+1555");
		expect(normalizeWhatsAppTarget("group:group:120@g.us")).toBeNull();
	});
});

describe("isWhatsAppUserTarget", () => {
	it("detects user JIDs with various formats", () => {
		expect(isWhatsAppUserTarget("41796666864:0@s.whatsapp.net")).toBe(true);
		expect(isWhatsAppUserTarget("1234567890@s.whatsapp.net")).toBe(true);
		expect(isWhatsAppUserTarget("123456789@lid")).toBe(true);
		expect(isWhatsAppUserTarget("123456789@LID")).toBe(true);
		expect(isWhatsAppUserTarget("123@lid:0")).toBe(false);
		expect(isWhatsAppUserTarget("abc@s.whatsapp.net")).toBe(false);
		expect(isWhatsAppUserTarget("123456789-987654321@g.us")).toBe(false);
		expect(isWhatsAppUserTarget("+1555123")).toBe(false);
	});
});

describe("isWhatsAppGroupJid", () => {
	it("detects group JIDs with or without prefixes", () => {
		expect(isWhatsAppGroupJid("120363401234567890@g.us")).toBe(true);
		expect(isWhatsAppGroupJid("123456789-987654321@g.us")).toBe(true);
		expect(isWhatsAppGroupJid("whatsapp:120363401234567890@g.us")).toBe(true);
		expect(isWhatsAppGroupJid("whatsapp:group:120363401234567890@g.us")).toBe(
			false,
		);
		expect(isWhatsAppGroupJid("x@g.us")).toBe(false);
		expect(isWhatsAppGroupJid("@g.us")).toBe(false);
		expect(isWhatsAppGroupJid("120@g.usx")).toBe(false);
		expect(isWhatsAppGroupJid("+1555123")).toBe(false);
	});
});
