import { describe, expect, it } from "vitest";
import {
	mockSuccessfulCliRun,
	runExistingCodexCliAgent,
	setupCliRunnerTestModule,
	supervisorSpawnMock,
} from "./cli-runner.test-support.js";

describe("runCliAgent session behavior", () => {
	it("keeps resuming the CLI across model changes and passes the new model flag", async () => {
		const runCliAgent = await setupCliRunnerTestModule();
		mockSuccessfulCliRun();

		await runExistingCodexCliAgent({
			runCliAgent,
			runId: "run-model-switch",
			cliSessionBindingAuthProfileId: "openai:default",
			authProfileId: "openai:default",
		});

		const input = supervisorSpawnMock.mock.calls[0]?.[0] as { argv?: string[] };
		expect(input.argv).toEqual([
			"codex",
			"exec",
			"resume",
			"thread-123",
			"--json",
			"--model",
			"gpt-5.4",
			"hi",
		]);
	});

	it("starts a fresh CLI session when the auth profile changes", async () => {
		const runCliAgent = await setupCliRunnerTestModule();
		mockSuccessfulCliRun();

		await runExistingCodexCliAgent({
			runCliAgent,
			runId: "run-auth-change",
			cliSessionBindingAuthProfileId: "openai:work",
			authProfileId: "openai:personal",
		});

		const input = supervisorSpawnMock.mock.calls[0]?.[0] as {
			argv?: string[];
			scopeKey?: string;
		};
		expect(input.argv).toEqual([
			"codex",
			"exec",
			"--json",
			"--model",
			"gpt-5.4",
			"hi",
		]);
		expect(input.scopeKey).toBeUndefined();
	});
});
