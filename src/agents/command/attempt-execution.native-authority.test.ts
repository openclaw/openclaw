import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveModelFallbackError } from "../failover-error.js";
import { renderRuntimeCoordinationFailureCopy } from "../failover/assistant-request-failure-copy.js";
import { prepareFallbackPrompts } from "./attempt-execution.cli-session.js";
import { makeRunAgentAttemptParams } from "./attempt-execution.cli.test-support.js";

const directories = useAutoCleanupTempDirTracker(afterEach);
afterEach(clearRuntimeConfigSnapshot);
afterEach(() => vi.unstubAllEnvs());

it("uses live runtime configuration to revoke previously prepared native context", async () => {
  const root = directories.make("native-private-authority-");
  const cwd = path.join(root, "workspace");
  const profile = path.join(root, "selected");
  const project = path.join(profile, "projects", "synthetic-project");
  await fs.mkdir(cwd, { recursive: true });
  await fs.mkdir(project, { recursive: true });
  await fs.writeFile(
    path.join(project, "native-session.jsonl"),
    JSON.stringify({
      type: "assistant",
      message: { role: "assistant", content: "Native profile canary" },
    }) + "\n",
  );
  vi.stubEnv("CLAUDE_CONFIG_DIR", undefined);
  const config = (selected: string): OpenClawConfig => ({
    skills: { entries: { "native-profile": { env: { CLAUDE_CONFIG_DIR: selected } } } },
  });
  const initial = config(profile);
  setRuntimeConfigSnapshot(initial);
  const run = makeRunAgentAttemptParams({
    cfg: initial,
    agentDir: root,
    workspaceDir: cwd,
    sessionKey: "agent:main:private-native",
    originalProvider: "claude-cli",
    providerOverride: "openai",
    isFallbackRetry: true,
    skillsSnapshot: { prompt: "", skills: [{ name: "native-profile" }] },
    sessionEntry: {
      sessionId: "local-session",
      updatedAt: 1,
      cliSessionBindings: {
        "claude-cli": {
          sessionId: "native-session",
          cwd,
          transcriptRoot: path.join(profile, "projects"),
        },
      },
    },
  });
  const prompt = await prepareFallbackPrompts({ run, childCwd: cwd, isRawModelRun: false });
  expect(prompt.effectivePrompt).toContain("Native profile canary");
  expect(prompt.assertPrivateInputCurrent).toBeTypeOf("function");
  prompt.assertPrivateInputCurrent?.();
  setRuntimeConfigSnapshot(config(path.join(root, "replacement")));
  let rejected: unknown;
  try {
    prompt.assertPrivateInputCurrent?.();
  } catch (error) {
    rejected = error;
  }
  expect(rejected).toMatchObject({
    name: "NativeHistoryAuthorizationChangedError",
    code: "native_history_authorization_changed",
  });
  expect(resolveModelFallbackError(rejected).kind).toBe("coordination");
  expect(renderRuntimeCoordinationFailureCopy("native_history_authorization_changed")).toContain(
    "send the request again",
  );
  const retried = await prepareFallbackPrompts({ run, childCwd: cwd, isRawModelRun: false });
  expect(retried.effectivePrompt).not.toContain("Native profile canary");
  expect(retried.assertPrivateInputCurrent).toBeUndefined();
  setRuntimeConfigSnapshot(initial);
  const differentAttempt = await prepareFallbackPrompts({
    run: { ...run, cfg: config(path.join(root, "explicit-other-profile")) },
    childCwd: cwd,
    isRawModelRun: false,
  });
  // Skill selection deliberately uses its live runtime owner, as child execution does.
  expect(differentAttempt.effectivePrompt).toContain("Native profile canary");
  differentAttempt.assertPrivateInputCurrent?.();
});
