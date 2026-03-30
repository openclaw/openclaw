import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
import {
	createManagedRun,
	mockSuccessfulCliRun,
	runCliAgentWithBackendConfig,
	SMALL_PNG_BASE64,
	setupCliRunnerTestModule,
	stubBootstrapContext,
	supervisorSpawnMock,
} from "./cli-runner.test-support.js";

describe("runCliAgent spawn path", () => {
	it("does not inject hardcoded 'Tools are disabled' text into CLI arguments", async () => {
		const runCliAgent = await setupCliRunnerTestModule();
		supervisorSpawnMock.mockResolvedValueOnce(
			createManagedRun({
				reason: "exit",
				exitCode: 0,
				exitSignal: null,
				durationMs: 50,
				stdout: "ok",
				stderr: "",
				timedOut: false,
				noOutputTimedOut: false,
			}),
		);

		await runCliAgent({
			sessionId: "s1",
			sessionFile: "/tmp/session.jsonl",
			workspaceDir: "/tmp",
			prompt: "Run: node script.mjs",
			provider: "claude-cli",
			model: "sonnet",
			timeoutMs: 1_000,
			runId: "run-no-tools-disabled",
			extraSystemPrompt: "You are a helpful assistant.",
		});

		const input = supervisorSpawnMock.mock.calls[0]?.[0] as { argv?: string[] };
		const allArgs = (input.argv ?? []).join("\n");
		expect(allArgs).not.toContain("Tools are disabled in this session");
		expect(allArgs).toContain("You are a helpful assistant.");
	});

	it("injects a strict empty MCP config for bundle-MCP-enabled Claude CLI runs", async () => {
		const runCliAgent = await setupCliRunnerTestModule();
		supervisorSpawnMock.mockResolvedValueOnce(
			createManagedRun({
				reason: "exit",
				exitCode: 0,
				exitSignal: null,
				durationMs: 50,
				stdout: JSON.stringify({
					session_id: "session-123",
					message: "ok",
				}),
				stderr: "",
				timedOut: false,
				noOutputTimedOut: false,
			}),
		);

		await runCliAgent({
			sessionId: "s1",
			sessionFile: "/tmp/session.jsonl",
			workspaceDir: "/tmp",
			config: {
				agents: {
					defaults: {
						cliBackends: {
							"claude-cli": {
								command: "node",
								args: ["/tmp/fake-claude.mjs"],
								clearEnv: [],
							},
						},
					},
				},
			} satisfies OpenClawConfig,
			prompt: "hi",
			provider: "claude-cli",
			model: "claude-sonnet-4-6",
			timeoutMs: 1_000,
			runId: "run-bundle-mcp-empty",
		});

		const input = supervisorSpawnMock.mock.calls[0]?.[0] as { argv?: string[] };
		expect(input.argv?.[0]).toBe("node");
		expect(input.argv).toContain("/tmp/fake-claude.mjs");
		expect(input.argv).toContain("--strict-mcp-config");
		const configFlagIndex = input.argv?.indexOf("--mcp-config") ?? -1;
		expect(configFlagIndex).toBeGreaterThanOrEqual(0);
		expect(input.argv?.[configFlagIndex + 1]).toMatch(/^\/.+\/mcp\.json$/);
	});

	it("runs CLI through supervisor and returns payload", async () => {
		const runCliAgent = await setupCliRunnerTestModule();
		supervisorSpawnMock.mockResolvedValueOnce(
			createManagedRun({
				reason: "exit",
				exitCode: 0,
				exitSignal: null,
				durationMs: 50,
				stdout: "ok",
				stderr: "",
				timedOut: false,
				noOutputTimedOut: false,
			}),
		);

		const result = await runCliAgent({
			sessionId: "s1",
			sessionFile: "/tmp/session.jsonl",
			workspaceDir: "/tmp",
			prompt: "hi",
			provider: "codex-cli",
			model: "gpt-5.2-codex",
			timeoutMs: 1_000,
			runId: "run-1",
			cliSessionId: "thread-123",
		});

		expect(result.payloads?.[0]?.text).toBe("ok");
		const input = supervisorSpawnMock.mock.calls[0]?.[0] as {
			argv?: string[];
			mode?: string;
			timeoutMs?: number;
			noOutputTimeoutMs?: number;
			replaceExistingScope?: boolean;
			scopeKey?: string;
		};
		expect(input.mode).toBe("child");
		expect(input.argv?.[0]).toBe("codex");
		expect(input.timeoutMs).toBe(1_000);
		expect(input.noOutputTimeoutMs).toBeGreaterThanOrEqual(1_000);
		expect(input.replaceExistingScope).toBe(true);
		expect(input.scopeKey).toContain("thread-123");
	});

	it("sanitizes dangerous backend env overrides before spawn", async () => {
		const runCliAgent = await setupCliRunnerTestModule();
		mockSuccessfulCliRun();
		await runCliAgentWithBackendConfig({
			runCliAgent,
			backend: {
				command: "codex",
				env: {
					NODE_OPTIONS: "--require ./malicious.js",
					LD_PRELOAD: "/tmp/pwn.so",
					PATH: "/tmp/evil",
					HOME: "/tmp/evil-home",
					SAFE_KEY: "ok",
				},
			},
			runId: "run-env-sanitized",
		});

		const input = supervisorSpawnMock.mock.calls[0]?.[0] as {
			env?: Record<string, string | undefined>;
		};
		expect(input.env?.SAFE_KEY).toBe("ok");
		expect(input.env?.PATH).toBe(process.env.PATH);
		expect(input.env?.HOME).toBe(process.env.HOME);
		expect(input.env?.NODE_OPTIONS).toBeUndefined();
		expect(input.env?.LD_PRELOAD).toBeUndefined();
	});

	it("applies clearEnv after sanitizing backend env overrides", async () => {
		const runCliAgent = await setupCliRunnerTestModule();
		process.env.SAFE_CLEAR = "from-base";
		mockSuccessfulCliRun();
		await runCliAgentWithBackendConfig({
			runCliAgent,
			backend: {
				command: "codex",
				env: {
					SAFE_KEEP: "keep-me",
				},
				clearEnv: ["SAFE_CLEAR"],
			},
			runId: "run-clear-env",
		});

		const input = supervisorSpawnMock.mock.calls[0]?.[0] as {
			env?: Record<string, string | undefined>;
		};
		expect(input.env?.SAFE_KEEP).toBe("keep-me");
		expect(input.env?.SAFE_CLEAR).toBeUndefined();
	});

	it("prepends bootstrap warnings to the CLI prompt body", async () => {
		const runCliAgent = await setupCliRunnerTestModule();
		supervisorSpawnMock.mockResolvedValueOnce(
			createManagedRun({
				reason: "exit",
				exitCode: 0,
				exitSignal: null,
				durationMs: 50,
				stdout: "ok",
				stderr: "",
				timedOut: false,
				noOutputTimedOut: false,
			}),
		);
		stubBootstrapContext({
			bootstrapFiles: [
				{
					name: "AGENTS.md",
					path: "/tmp/AGENTS.md",
					content: "A".repeat(200),
					missing: false,
				},
			],
			contextFiles: [{ path: "AGENTS.md", content: "A".repeat(20) }],
		});

		await runCliAgent({
			sessionId: "s1",
			sessionFile: "/tmp/session.jsonl",
			workspaceDir: "/tmp",
			config: {
				agents: {
					defaults: {
						bootstrapMaxChars: 50,
						bootstrapTotalMaxChars: 50,
					},
				},
			} satisfies OpenClawConfig,
			prompt: "hi",
			provider: "codex-cli",
			model: "gpt-5.2-codex",
			timeoutMs: 1_000,
			runId: "run-warning",
			cliSessionId: "thread-123",
		});

		const input = supervisorSpawnMock.mock.calls[0]?.[0] as {
			argv?: string[];
			input?: string;
		};
		const promptCarrier = [input.input ?? "", ...(input.argv ?? [])].join("\n");

		expect(promptCarrier).toContain("[Bootstrap truncation warning]");
		expect(promptCarrier).toContain("- AGENTS.md: 200 raw -> 20 injected");
		expect(promptCarrier).toContain("hi");
	});

	it("hydrates prompt media refs into CLI image args", async () => {
		const runCliAgent = await setupCliRunnerTestModule();
		supervisorSpawnMock.mockResolvedValueOnce(
			createManagedRun({
				reason: "exit",
				exitCode: 0,
				exitSignal: null,
				durationMs: 50,
				stdout: "ok",
				stderr: "",
				timedOut: false,
				noOutputTimedOut: false,
			}),
		);

		const tempDir = await fs.mkdtemp(
			path.join(resolvePreferredOpenClawTmpDir(), "openclaw-cli-prompt-image-"),
		);
		const sourceImage = path.join(tempDir, "bb-image.png");
		await fs.writeFile(sourceImage, Buffer.from(SMALL_PNG_BASE64, "base64"));

		try {
			await runCliAgent({
				sessionId: "s1",
				sessionFile: "/tmp/session.jsonl",
				workspaceDir: tempDir,
				prompt: `[media attached: ${sourceImage} (image/png)]\n\n<media:image>`,
				provider: "codex-cli",
				model: "gpt-5.2-codex",
				timeoutMs: 1_000,
				runId: "run-prompt-image",
			});
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}

		const input = supervisorSpawnMock.mock.calls[0]?.[0] as { argv?: string[] };
		const argv = input.argv ?? [];
		const imageArgIndex = argv.indexOf("--image");
		expect(imageArgIndex).toBeGreaterThanOrEqual(0);
		expect(argv[imageArgIndex + 1]).toContain("openclaw-cli-images-");
		expect(argv[imageArgIndex + 1]).not.toBe(sourceImage);
	});

	it("appends hydrated prompt media refs to generic backend prompts", async () => {
		const runCliAgent = await setupCliRunnerTestModule();
		supervisorSpawnMock.mockResolvedValueOnce(
			createManagedRun({
				reason: "exit",
				exitCode: 0,
				exitSignal: null,
				durationMs: 50,
				stdout: "ok",
				stderr: "",
				timedOut: false,
				noOutputTimedOut: false,
			}),
		);

		const tempDir = await fs.mkdtemp(
			path.join(
				resolvePreferredOpenClawTmpDir(),
				"openclaw-cli-prompt-image-generic-",
			),
		);
		const sourceImage = path.join(tempDir, "claude-image.png");
		await fs.writeFile(sourceImage, Buffer.from(SMALL_PNG_BASE64, "base64"));

		try {
			await runCliAgent({
				sessionId: "s1",
				sessionFile: "/tmp/session.jsonl",
				workspaceDir: tempDir,
				prompt: `[media attached: ${sourceImage} (image/png)]\n\n<media:image>`,
				provider: "claude-cli",
				model: "claude-opus-4-1",
				timeoutMs: 1_000,
				runId: "run-prompt-image-generic",
			});
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}

		const input = supervisorSpawnMock.mock.calls[0]?.[0] as {
			argv?: string[];
			input?: string;
		};
		const argv = input.argv ?? [];
		expect(argv).not.toContain("--image");
		const promptCarrier = [input.input ?? "", ...argv].join("\n");
		const appendedPath = argv.find((value) =>
			value.includes("openclaw-cli-images-"),
		);
		expect(appendedPath).toBeDefined();
		expect(appendedPath).not.toBe(sourceImage);
		expect(promptCarrier).toContain(appendedPath ?? "");
	});

	it("prefers explicit images over prompt refs", async () => {
		const runCliAgent = await setupCliRunnerTestModule();
		supervisorSpawnMock.mockResolvedValueOnce(
			createManagedRun({
				reason: "exit",
				exitCode: 0,
				exitSignal: null,
				durationMs: 50,
				stdout: "ok",
				stderr: "",
				timedOut: false,
				noOutputTimedOut: false,
			}),
		);

		const tempDir = await fs.mkdtemp(
			path.join(
				resolvePreferredOpenClawTmpDir(),
				"openclaw-cli-explicit-images-",
			),
		);
		const sourceImage = path.join(tempDir, "ignored-prompt-image.png");
		await fs.writeFile(sourceImage, Buffer.from(SMALL_PNG_BASE64, "base64"));

		try {
			await runCliAgent({
				sessionId: "s1",
				sessionFile: "/tmp/session.jsonl",
				workspaceDir: tempDir,
				prompt: `[media attached: ${sourceImage} (image/png)]\n\n<media:image>`,
				images: [
					{ type: "image", data: SMALL_PNG_BASE64, mimeType: "image/png" },
				],
				provider: "codex-cli",
				model: "gpt-5.2-codex",
				timeoutMs: 1_000,
				runId: "run-explicit-image-precedence",
			});
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}

		const input = supervisorSpawnMock.mock.calls[0]?.[0] as { argv?: string[] };
		const argv = input.argv ?? [];
		expect(argv.filter((arg) => arg === "--image")).toHaveLength(1);
	});

	it("falls back to per-agent workspace when workspaceDir is missing", async () => {
		const runCliAgent = await setupCliRunnerTestModule();
		const tempDir = await fs.mkdtemp(
			path.join(process.env.TMPDIR ?? "/tmp", "openclaw-cli-runner-"),
		);
		const fallbackWorkspace = path.join(tempDir, "workspace-main");
		await fs.mkdir(fallbackWorkspace, { recursive: true });
		const cfg = {
			agents: {
				defaults: {
					workspace: fallbackWorkspace,
				},
			},
		} satisfies OpenClawConfig;

		supervisorSpawnMock.mockResolvedValueOnce(
			createManagedRun({
				reason: "exit",
				exitCode: 0,
				exitSignal: null,
				durationMs: 25,
				stdout: "ok",
				stderr: "",
				timedOut: false,
				noOutputTimedOut: false,
			}),
		);

		try {
			await runCliAgent({
				sessionId: "s1",
				sessionKey: "agent:main:subagent:missing-workspace",
				sessionFile: "/tmp/session.jsonl",
				workspaceDir: undefined as unknown as string,
				config: cfg,
				prompt: "hi",
				provider: "codex-cli",
				model: "gpt-5.2-codex",
				timeoutMs: 1_000,
				runId: "run-4",
			});
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}

		const input = supervisorSpawnMock.mock.calls[0]?.[0] as { cwd?: string };
		expect(input.cwd).toBe(path.resolve(fallbackWorkspace));
	});
});
