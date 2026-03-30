import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { captureEnv } from "../test-utils/env.js";
import {
	writeBundleProbeMcpServer,
	writeClaudeBundle,
	writeFakeClaudeCli,
} from "./bundle-mcp.test-harness.js";
import { runCliAgent } from "./cli-runner.js";

const E2E_TIMEOUT_MS = 20_000;

describe("runCliAgent bundle MCP e2e", () => {
	it("routes enabled bundle MCP config into the claude-cli backend and executes the tool", {
		timeout: E2E_TIMEOUT_MS,
	}, async () => {
		const envSnapshot = captureEnv(["HOME"]);
		const tempHome = await fs.mkdtemp(
			path.join(os.tmpdir(), "openclaw-cli-bundle-mcp-"),
		);
		process.env.HOME = tempHome;

		const workspaceDir = path.join(tempHome, "workspace");
		const sessionFile = path.join(tempHome, "session.jsonl");
		const binDir = path.join(tempHome, "bin");
		const serverScriptPath = path.join(tempHome, "mcp", "bundle-probe.mjs");
		const fakeClaudePath = path.join(binDir, "fake-claude.mjs");
		const pluginRoot = path.join(
			tempHome,
			".openclaw",
			"extensions",
			"bundle-probe",
		);
		await fs.mkdir(workspaceDir, { recursive: true });
		await writeBundleProbeMcpServer(serverScriptPath);
		await writeFakeClaudeCli(fakeClaudePath);
		await writeClaudeBundle({ pluginRoot, serverScriptPath });

		const config: OpenClawConfig = {
			agents: {
				defaults: {
					workspace: workspaceDir,
					cliBackends: {
						"claude-cli": {
							command: "node",
							args: [fakeClaudePath],
							clearEnv: [],
						},
					},
				},
			},
			plugins: {
				entries: {
					"bundle-probe": { enabled: true },
				},
			},
		};

		try {
			const result = await runCliAgent({
				sessionId: "session:test",
				sessionFile,
				workspaceDir,
				config,
				prompt:
					"Use your configured MCP tools and report the bundle probe text.",
				provider: "claude-cli",
				model: "test-bundle",
				timeoutMs: 10_000,
				runId: "bundle-mcp-e2e",
			});

			expect(result.payloads?.[0]?.text).toContain("BUNDLE MCP OK FROM-BUNDLE");
			expect(result.meta.agentMeta?.sessionId.length ?? 0).toBeGreaterThan(0);
		} finally {
			await fs.rm(tempHome, { recursive: true, force: true });
			envSnapshot.restore();
		}
	});
});
