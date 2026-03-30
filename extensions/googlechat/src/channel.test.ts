import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createDirectoryTestRuntime,
	expectDirectorySurface,
} from "../../../test/helpers/plugins/directory.ts";
import type { OpenClawConfig } from "../runtime-api.js";

const uploadGoogleChatAttachmentMock = vi.hoisted(() => vi.fn());
const sendGoogleChatMessageMock = vi.hoisted(() => vi.fn());
const resolveGoogleChatAccountMock = vi.hoisted(() => vi.fn());
const resolveGoogleChatOutboundSpaceMock = vi.hoisted(() => vi.fn());
const loadWebMediaMock = vi.hoisted(() => vi.fn());
const fetchRemoteMediaMock = vi.hoisted(() => vi.fn());

vi.mock("./api.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./api.js")>();
	return {
		...actual,
		sendGoogleChatMessage: sendGoogleChatMessageMock,
		uploadGoogleChatAttachment: uploadGoogleChatAttachmentMock,
	};
});

vi.mock("./accounts.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./accounts.js")>();
	return {
		...actual,
		resolveGoogleChatAccount: resolveGoogleChatAccountMock,
	};
});

vi.mock("./targets.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./targets.js")>();
	return {
		...actual,
		resolveGoogleChatOutboundSpace: resolveGoogleChatOutboundSpaceMock,
	};
});

vi.mock("../runtime-api.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../runtime-api.js")>();
	return {
		...actual,
		loadWebMedia: (...args: Parameters<typeof actual.loadWebMedia>) =>
			loadWebMediaMock(...args),
		fetchRemoteMedia: (...args: Parameters<typeof actual.fetchRemoteMedia>) =>
			fetchRemoteMediaMock(...args),
	};
});

const accountsActual =
	await vi.importActual<typeof import("./accounts.js")>("./accounts.js");
const targetsActual =
	await vi.importActual<typeof import("./targets.js")>("./targets.js");
const runtimeApiActual =
	await vi.importActual<typeof import("../runtime-api.js")>(
		"../runtime-api.js",
	);

resolveGoogleChatAccountMock.mockImplementation(
	accountsActual.resolveGoogleChatAccount,
);
resolveGoogleChatOutboundSpaceMock.mockImplementation(
	targetsActual.resolveGoogleChatOutboundSpace,
);

import { googlechatPlugin } from "./channel.js";

afterEach(() => {
	vi.clearAllMocks();
	resolveGoogleChatAccountMock.mockImplementation(
		accountsActual.resolveGoogleChatAccount,
	);
	resolveGoogleChatOutboundSpaceMock.mockImplementation(
		targetsActual.resolveGoogleChatOutboundSpace,
	);
	loadWebMediaMock.mockImplementation(runtimeApiActual.loadWebMedia);
	fetchRemoteMediaMock.mockImplementation(runtimeApiActual.fetchRemoteMedia);
});

function createGoogleChatCfg(): OpenClawConfig {
	return {
		channels: {
			googlechat: {
				enabled: true,
				serviceAccount: {
					type: "service_account",
					client_email: "bot@example.com",
					private_key: "test-key", // pragma: allowlist secret
					token_uri: "https://oauth2.googleapis.com/token",
				},
			},
		},
	};
}

function setupRuntimeMediaMocks(params: {
	loadFileName: string;
	loadBytes: string;
}) {
	const loadWebMedia = vi.fn(async () => ({
		buffer: Buffer.from(params.loadBytes),
		fileName: params.loadFileName,
		contentType: "image/png",
	}));
	const fetchRemoteMedia = vi.fn(async () => ({
		buffer: Buffer.from("remote-bytes"),
		fileName: "remote.png",
		contentType: "image/png",
	}));

	loadWebMediaMock.mockImplementation(loadWebMedia);
	fetchRemoteMediaMock.mockImplementation(fetchRemoteMedia);

	return { loadWebMedia, fetchRemoteMedia };
}

describe("googlechatPlugin outbound sendMedia", () => {
	it("chunks outbound text without requiring Google Chat runtime initialization", () => {
		const chunker = googlechatPlugin.outbound?.chunker;
		if (!chunker) {
			throw new Error(
				"Expected googlechatPlugin.outbound.chunker to be defined",
			);
		}

		expect(chunker("alpha beta", 5)).toEqual(["alpha", "beta"]);
	});

	it("loads local media with mediaLocalRoots via runtime media loader", async () => {
		const { loadWebMedia, fetchRemoteMedia } = setupRuntimeMediaMocks({
			loadFileName: "image.png",
			loadBytes: "image-bytes",
		});

		uploadGoogleChatAttachmentMock.mockResolvedValue({
			attachmentUploadToken: "token-1",
		});
		sendGoogleChatMessageMock.mockResolvedValue({
			messageName: "spaces/AAA/messages/msg-1",
		});

		const cfg = createGoogleChatCfg();

		const result = await googlechatPlugin.outbound?.sendMedia?.({
			cfg,
			to: "spaces/AAA",
			text: "caption",
			mediaUrl: "/tmp/workspace/image.png",
			mediaLocalRoots: ["/tmp/workspace"],
			accountId: "default",
		});

		expect(loadWebMedia).toHaveBeenCalledWith(
			"/tmp/workspace/image.png",
			expect.objectContaining({
				localRoots: ["/tmp/workspace"],
			}),
		);
		expect(fetchRemoteMedia).not.toHaveBeenCalled();
		expect(uploadGoogleChatAttachmentMock).toHaveBeenCalledWith(
			expect.objectContaining({
				space: "spaces/AAA",
				filename: "image.png",
				contentType: "image/png",
			}),
		);
		expect(sendGoogleChatMessageMock).toHaveBeenCalledWith(
			expect.objectContaining({
				space: "spaces/AAA",
				text: "caption",
			}),
		);
		expect(result).toEqual({
			channel: "googlechat",
			messageId: "spaces/AAA/messages/msg-1",
			chatId: "spaces/AAA",
		});
	});

	it("keeps remote URL media fetch on fetchRemoteMedia with maxBytes cap", async () => {
		const { loadWebMedia, fetchRemoteMedia } = setupRuntimeMediaMocks({
			loadFileName: "unused.png",
			loadBytes: "should-not-be-used",
		});

		uploadGoogleChatAttachmentMock.mockResolvedValue({
			attachmentUploadToken: "token-2",
		});
		sendGoogleChatMessageMock.mockResolvedValue({
			messageName: "spaces/AAA/messages/msg-2",
		});

		const cfg = createGoogleChatCfg();

		const result = await googlechatPlugin.outbound?.sendMedia?.({
			cfg,
			to: "spaces/AAA",
			text: "caption",
			mediaUrl: "https://example.com/image.png",
			accountId: "default",
		});

		expect(fetchRemoteMedia).toHaveBeenCalledWith(
			expect.objectContaining({
				url: "https://example.com/image.png",
				maxBytes: 20 * 1024 * 1024,
			}),
		);
		expect(loadWebMedia).not.toHaveBeenCalled();
		expect(uploadGoogleChatAttachmentMock).toHaveBeenCalledWith(
			expect.objectContaining({
				space: "spaces/AAA",
				filename: "remote.png",
				contentType: "image/png",
			}),
		);
		expect(sendGoogleChatMessageMock).toHaveBeenCalledWith(
			expect.objectContaining({
				space: "spaces/AAA",
				text: "caption",
			}),
		);
		expect(result).toEqual({
			channel: "googlechat",
			messageId: "spaces/AAA/messages/msg-2",
			chatId: "spaces/AAA",
		});
	});
});

const resolveTarget = googlechatPlugin.outbound?.resolveTarget;

describe("googlechatPlugin outbound resolveTarget", () => {
	it("resolves valid chat targets", () => {
		if (!resolveTarget) {
			throw new Error(
				"Expected googlechatPlugin.outbound.resolveTarget to be defined",
			);
		}

		const result = resolveTarget({
			to: "spaces/AAA",
			mode: "explicit",
			allowFrom: [],
		});

		expect(result.ok).toBe(true);
		if (!result.ok) {
			throw result.error;
		}
		expect(result.to).toBe("spaces/AAA");
	});

	it("resolves email targets", () => {
		if (!resolveTarget) {
			throw new Error(
				"Expected googlechatPlugin.outbound.resolveTarget to be defined",
			);
		}

		const result = resolveTarget({
			to: "user@example.com",
			mode: "explicit",
			allowFrom: [],
		});

		expect(result.ok).toBe(true);
		if (!result.ok) {
			throw result.error;
		}
		expect(result.to).toBe("users/user@example.com");
	});

	it("errors on invalid targets", () => {
		if (!resolveTarget) {
			throw new Error(
				"Expected googlechatPlugin.outbound.resolveTarget to be defined",
			);
		}

		const result = resolveTarget({
			to: "   ",
			mode: "explicit",
			allowFrom: [],
		});

		expect(result.ok).toBe(false);
		if (result.ok) {
			throw new Error("Expected invalid target to fail");
		}
		expect(result.error).toBeDefined();
	});

	it("errors when no target is provided", () => {
		if (!resolveTarget) {
			throw new Error(
				"Expected googlechatPlugin.outbound.resolveTarget to be defined",
			);
		}

		const result = resolveTarget({
			to: undefined,
			mode: "explicit",
			allowFrom: [],
		});

		expect(result.ok).toBe(false);
		if (result.ok) {
			throw new Error("Expected missing target to fail");
		}
		expect(result.error).toBeDefined();
	});
});

describe("googlechatPlugin outbound cfg threading", () => {
	it("preserves accountId when sending pairing approvals", async () => {
		const cfg = {
			channels: {
				googlechat: {
					enabled: true,
					accounts: {
						work: {
							serviceAccount: {
								type: "service_account",
							},
						},
					},
				},
			},
		};
		const account = {
			accountId: "work",
			config: {},
			credentialSource: "inline",
		};
		resolveGoogleChatAccountMock.mockReturnValue(account);
		resolveGoogleChatOutboundSpaceMock.mockResolvedValue("spaces/WORK");
		sendGoogleChatMessageMock.mockResolvedValue({
			messageName: "spaces/WORK/messages/msg-1",
		});

		await googlechatPlugin.pairing?.notifyApproval?.({
			cfg: cfg as never,
			id: "user@example.com",
			accountId: "work",
		});

		expect(resolveGoogleChatAccountMock).toHaveBeenCalledWith({
			cfg,
			accountId: "work",
		});
		expect(sendGoogleChatMessageMock).toHaveBeenCalledWith(
			expect.objectContaining({
				account,
				space: "spaces/WORK",
				text: expect.any(String),
			}),
		);
	});

	it("threads resolved cfg into sendText account resolution", async () => {
		const cfg = {
			channels: {
				googlechat: {
					serviceAccount: {
						type: "service_account",
					},
				},
			},
		};
		const account = {
			accountId: "default",
			config: {},
			credentialSource: "inline",
		};
		resolveGoogleChatAccountMock.mockReturnValue(account);
		resolveGoogleChatOutboundSpaceMock.mockResolvedValue("spaces/AAA");
		sendGoogleChatMessageMock.mockResolvedValue({
			messageName: "spaces/AAA/messages/msg-1",
		});

		await googlechatPlugin.outbound?.sendText?.({
			cfg: cfg as never,
			to: "users/123",
			text: "hello",
			accountId: "default",
		});

		expect(resolveGoogleChatAccountMock).toHaveBeenCalledWith({
			cfg,
			accountId: "default",
		});
		expect(sendGoogleChatMessageMock).toHaveBeenCalledWith(
			expect.objectContaining({
				account,
				space: "spaces/AAA",
				text: "hello",
			}),
		);
	});

	it("threads resolved cfg into sendMedia account and media loading path", async () => {
		const cfg = {
			channels: {
				googlechat: {
					serviceAccount: {
						type: "service_account",
					},
					mediaMaxMb: 8,
				},
			},
		};
		const account = {
			accountId: "default",
			config: { mediaMaxMb: 20 },
			credentialSource: "inline",
		};
		const { fetchRemoteMedia } = setupRuntimeMediaMocks({
			loadFileName: "unused.png",
			loadBytes: "should-not-be-used",
		});

		resolveGoogleChatAccountMock.mockReturnValue(account);
		resolveGoogleChatOutboundSpaceMock.mockResolvedValue("spaces/AAA");
		uploadGoogleChatAttachmentMock.mockResolvedValue({
			attachmentUploadToken: "token-1",
		});
		sendGoogleChatMessageMock.mockResolvedValue({
			messageName: "spaces/AAA/messages/msg-2",
		});

		await googlechatPlugin.outbound?.sendMedia?.({
			cfg: cfg as never,
			to: "users/123",
			text: "photo",
			mediaUrl: "https://example.com/file.png",
			accountId: "default",
		});

		expect(resolveGoogleChatAccountMock).toHaveBeenCalledWith({
			cfg,
			accountId: "default",
		});
		expect(fetchRemoteMedia).toHaveBeenCalledWith(
			expect.objectContaining({
				url: "https://example.com/file.png",
				maxBytes: 8 * 1024 * 1024,
			}),
		);
		expect(uploadGoogleChatAttachmentMock).toHaveBeenCalledWith(
			expect.objectContaining({
				account,
				space: "spaces/AAA",
				filename: "remote.png",
			}),
		);
		expect(sendGoogleChatMessageMock).toHaveBeenCalledWith(
			expect.objectContaining({
				account,
				attachments: [
					{ attachmentUploadToken: "token-1", contentName: "remote.png" },
				],
			}),
		);
	});

	it("sends media without requiring Google Chat runtime initialization", async () => {
		const { loadWebMedia } = setupRuntimeMediaMocks({
			loadFileName: "image.png",
			loadBytes: "image-bytes",
		});

		uploadGoogleChatAttachmentMock.mockResolvedValue({
			attachmentUploadToken: "token-cold",
		});
		sendGoogleChatMessageMock.mockResolvedValue({
			messageName: "spaces/AAA/messages/msg-cold",
		});

		const cfg = createGoogleChatCfg();

		await expect(
			googlechatPlugin.outbound?.sendMedia?.({
				cfg,
				to: "spaces/AAA",
				text: "caption",
				mediaUrl: "/tmp/workspace/image.png",
				mediaLocalRoots: ["/tmp/workspace"],
				accountId: "default",
			}),
		).resolves.toEqual({
			channel: "googlechat",
			messageId: "spaces/AAA/messages/msg-cold",
			chatId: "spaces/AAA",
		});

		expect(loadWebMedia).toHaveBeenCalledWith(
			"/tmp/workspace/image.png",
			expect.objectContaining({
				localRoots: ["/tmp/workspace"],
			}),
		);
	});
});

describe("googlechat directory", () => {
	const runtimeEnv = createDirectoryTestRuntime() as never;

	it("lists peers and groups from config", async () => {
		const cfg = {
			channels: {
				googlechat: {
					serviceAccount: { client_email: "bot@example.com" },
					dm: { allowFrom: ["users/alice", "googlechat:bob"] },
					groups: {
						"spaces/AAA": {},
						"spaces/BBB": {},
					},
				},
			},
		} as unknown as OpenClawConfig;

		const directory = expectDirectorySurface(googlechatPlugin.directory);

		await expect(
			directory.listPeers({
				cfg,
				accountId: undefined,
				query: undefined,
				limit: undefined,
				runtime: runtimeEnv,
			}),
		).resolves.toEqual(
			expect.arrayContaining([
				{ kind: "user", id: "users/alice" },
				{ kind: "user", id: "bob" },
			]),
		);

		await expect(
			directory.listGroups({
				cfg,
				accountId: undefined,
				query: undefined,
				limit: undefined,
				runtime: runtimeEnv,
			}),
		).resolves.toEqual(
			expect.arrayContaining([
				{ kind: "group", id: "spaces/AAA" },
				{ kind: "group", id: "spaces/BBB" },
			]),
		);
	});

	it("normalizes spaced provider-prefixed dm allowlist entries", async () => {
		const cfg = {
			channels: {
				googlechat: {
					serviceAccount: { client_email: "bot@example.com" },
					dm: {
						allowFrom: [" users/alice ", " googlechat:user:Bob@Example.com "],
					},
				},
			},
		} as unknown as OpenClawConfig;

		const directory = expectDirectorySurface(googlechatPlugin.directory);

		await expect(
			directory.listPeers({
				cfg,
				accountId: undefined,
				query: undefined,
				limit: undefined,
				runtime: runtimeEnv,
			}),
		).resolves.toEqual(
			expect.arrayContaining([
				{ kind: "user", id: "users/alice" },
				{ kind: "user", id: "users/bob@example.com" },
			]),
		);
	});
});

describe("googlechatPlugin security", () => {
	it("normalizes prefixed DM allowlist entries to lowercase user ids", () => {
		const security = googlechatPlugin.security;
		if (!security) {
			throw new Error("googlechat security unavailable");
		}
		const resolveDmPolicy = security.resolveDmPolicy;
		const normalizeAllowEntry = googlechatPlugin.pairing?.normalizeAllowEntry;
		expect(resolveDmPolicy).toBeTypeOf("function");
		expect(normalizeAllowEntry).toBeTypeOf("function");

		const cfg = {
			channels: {
				googlechat: {
					serviceAccount: { client_email: "bot@example.com" },
					dm: {
						policy: "allowlist",
						allowFrom: ["  googlechat:user:Bob@Example.com  "],
					},
				},
			},
		} as OpenClawConfig;

		const account = googlechatPlugin.config.resolveAccount(cfg, "default");
		const resolved = resolveDmPolicy?.({ cfg, account });
		if (!resolved) {
			throw new Error("googlechat resolveDmPolicy returned null");
		}

		expect(resolved.policy).toBe("allowlist");
		expect(resolved.allowFrom).toEqual(["  googlechat:user:Bob@Example.com  "]);
		expect(
			resolved.normalizeEntry?.("  googlechat:user:Bob@Example.com  "),
		).toBe("bob@example.com");
		expect(normalizeAllowEntry?.("  users/Alice@Example.com  ")).toBe(
			"alice@example.com",
		);
	});
});
