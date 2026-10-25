import path from "node:path";
import type { EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams } from "openclaw/plugin-sdk/agent-harness";
import { AUTH_PROFILE_RUNTIME_CONTRACT as contract } from "openclaw/plugin-sdk/agent-runtime-test-contracts";
import { setRuntimeConfigSnapshot } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { beforeEach, expect, it, vi } from "vitest";
import { seedRunSessionOwnerForTest } from "./run-attempt-session-owners.test-support.js";
import {
  createParams,
  runCodexAppServerAttempt,
  setupRunAttemptTestHooks,
  tempDir,
} from "./run-attempt-test-harness.js";
import { createSandboxContext } from "./sandbox-exec-server.test-helpers.js";
import { writeCodexAppServerBinding } from "./session-binding.test-helpers.js";

setupRunAttemptTestHooks();
let params: EmbeddedRunAttemptParams;
let clientFactory: NonNullable<Parameters<typeof runCodexAppServerAttempt>[1]>["clientFactory"];

beforeEach(() => {
  params = createParams(path.join(tempDir, "session.jsonl"), tempDir, {
    prompt: contract.workspacePrompt,
    sessionId: contract.sessionId,
    sessionKey: contract.sessionKey,
    runId: contract.runId,
    provider: contract.codexHarnessProvider,
  });
  delete params.contextTokenBudget;
  delete params.contextWindowInfo;
  delete params.observeToolTerminal;
  clientFactory = vi.fn(async () => {
    throw new Error("unexpected app-server startup");
  });
});

function runAttempt() {
  setRuntimeConfigSnapshot(params.config ?? {});
  return runCodexAppServerAttempt(params, { clientFactory });
}

it("rejects a missing bound auth profile before app-server startup", async () => {
  await seedRunSessionOwnerForTest(contract.sessionId, contract.sessionKey);
  await writeCodexAppServerBinding(params.sessionFile, {
    threadId: "thread-auth-contract",
    cwd: tempDir,
    authProfileId: "openai:missing",
    webSearchThreadConfigFingerprint: JSON.stringify({
      "features.standalone_web_search": false,
      web_search: "disabled",
    }),
  });
  const rejection = await runAttempt().catch((error: unknown) => error);
  expect(rejection).toBeInstanceOf(Error);
  expect(rejection).toMatchObject({
    code: "selected_auth_profile_unavailable",
    message: expect.stringContaining(
      'auth profile "openai:missing" was not found in the OpenClaw credential store.',
    ),
  });
  expect(rejection).not.toHaveProperty("status");
  expect(clientFactory).not.toHaveBeenCalled();
});

it("rejects ambient auth before a remote-exec attempt starts", async () => {
  vi.stubEnv("CODEX_API_KEY", "ambient-codex-key");
  vi.stubEnv("OPENAI_API_KEY", "ambient-openai-key");
  params.authProfileStore = { version: 1, profiles: {} };
  params.sandbox = {
    ...createSandboxContext({}),
    placementExecutionMode: "remote-exec",
  } as NonNullable<typeof params.sandbox> & { placementExecutionMode: "remote-exec" };
  await expect(runAttempt()).rejects.toThrow(
    "Codex remote-exec cloud placement requires prepared OpenAI auth",
  );
  expect(clientFactory).not.toHaveBeenCalled();
});
