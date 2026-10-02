import fs from "node:fs/promises";
import path from "node:path";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanupRuntimeToolFixtureTempRoots,
  makeEnv,
  transcriptToolCall,
  transcriptToolResult,
  writeQaSessionTranscript,
} from "../test/runtime-tool-fixture-helpers.js";
import { getQaNativeWorkspaceBehavior } from "./native-workspace-behavior.js";
import { runRuntimeToolFixture } from "./runtime-tool-fixture.js";

const OPENCLAW_TOOL_BY_BEHAVIOR = {
  bash: "exec",
  edit: "edit",
  exec: "exec",
  "fs-read": "read",
  "fs-write": "write",
  grep: "exec",
} as const;

afterEach(() => {
  resetPluginStateStoreForTests({ closeDatabase: false });
});
afterAll(cleanupRuntimeToolFixtureTempRoots);

describe("Codex-native workspace runtime tool fixtures", () => {
  it.each(["bash", "edit", "exec", "fs-read", "fs-write", "grep"] as const)(
    "requires correlated native receipts and observable %s outcomes",
    async (behaviorId) => {
      const env = await makeEnv();
      env.gateway.runtimeEnv.OPENCLAW_QA_FORCE_RUNTIME = "codex";
      const behavior = getQaNativeWorkspaceBehavior(behaviorId);
      const happyArguments =
        behavior.nativeToolName === "bash"
          ? { command: `/bin/zsh -lc ${JSON.stringify(behavior.happyArgs.cmd)}` }
          : {
              changes: [
                {
                  path: behavior.happyMutation?.path,
                  kind: { type: "update" },
                },
              ],
            };
      const failureArguments =
        behavior.nativeToolName === "bash"
          ? { command: `/bin/zsh -lc ${JSON.stringify(behavior.failureArgs.cmd)}` }
          : {
              changes: [
                {
                  path: behavior.failureSentinel?.path,
                  kind: { type: "update" },
                },
              ],
            };
      const runtimeToolName = OPENCLAW_TOOL_BY_BEHAVIOR[behaviorId];
      if (behaviorId === "fs-write" && behavior.happyMutation) {
        await fs.writeFile(
          path.join(env.gateway.workspaceDir, behavior.happyMutation.path),
          behavior.happyMutation.contents,
          "utf8",
        );
      }

      let generatedSessionIndex = 0;
      const promptEvidence: Array<{
        transcriptToolName?: string;
        requireSuccessfulTranscriptToolResult?: boolean;
      }> = [];
      const details = await runRuntimeToolFixture(
        env,
        {
          toolName: OPENCLAW_TOOL_BY_BEHAVIOR[behaviorId],
          nativeWorkspaceBehavior: behaviorId,
          toolCoverage: {
            bucket: "codex-native-workspace",
            expectedLayer: "codex-native-workspace",
            required: true,
          },
        },
        {
          createSession: vi.fn(async (_env, label, key) => {
            expect(key).toBeUndefined();
            const phase = label.endsWith(" happy") ? "happy" : "failure";
            generatedSessionIndex += 1;
            return `agent:qa:native-workspace:${runtimeToolName}:${generatedSessionIndex}:${phase}`;
          }),
          readEffectiveTools: vi.fn(async () => new Set<string>()),
          runAgentPrompt: vi.fn(async (_env, params) => {
            promptEvidence.push({
              transcriptToolName: params.transcriptToolName,
              requireSuccessfulTranscriptToolResult: params.requireSuccessfulTranscriptToolResult,
            });
            const phase = params.sessionKey.endsWith(":happy") ? "happy" : "failure";
            const transcriptArguments = phase === "happy" ? happyArguments : failureArguments;
            await writeQaSessionTranscript(env, params.sessionKey, [
              transcriptToolCall(behavior.nativeToolName, phase, transcriptArguments),
              transcriptToolResult(
                behavior.nativeToolName,
                phase,
                phase === "happy"
                  ? (behavior.happyOutputMarker ?? "native workspace change completed")
                  : (behavior.failureOutputMarker ?? "path escapes workspace root"),
                phase === "failure" ? true : undefined,
              ),
            ]);
            if (behaviorId === "fs-write" && phase === "failure") {
              const sentinel = behavior.failureSentinel;
              if (!sentinel) {
                throw new Error("fs-write failure must use an outside-workspace sentinel");
              }
              await expect(
                fs.readFile(path.resolve(env.gateway.workspaceDir, sentinel.path), "utf8"),
              ).resolves.toBe(sentinel.contents);
            }
            if (phase === "happy" && behavior.happyMutation) {
              const mutationPath = path.join(env.gateway.workspaceDir, behavior.happyMutation.path);
              if (behaviorId === "fs-write") {
                await expect(fs.readFile(mutationPath, "utf8")).rejects.toThrow();
              }
              await fs.writeFile(mutationPath, behavior.happyMutation.contents, "utf8");
            }
            return {};
          }),
          fetchJson: vi.fn(),
          ensureImageGenerationConfigured: vi.fn(),
        },
      );

      expect(promptEvidence).toEqual([
        {
          transcriptToolName: behavior.nativeToolName,
          requireSuccessfulTranscriptToolResult: true,
        },
        {
          transcriptToolName: behavior.nativeToolName,
          requireSuccessfulTranscriptToolResult: undefined,
        },
      ]);
      expect(details).toContain(`codex-native ${behaviorId} behavior passed`);
      if (behavior.happyMutation) {
        await expect(
          fs.readFile(path.join(env.gateway.workspaceDir, behavior.happyMutation.path), "utf8"),
        ).resolves.toBe(behavior.happyMutation.contents);
      }
      if (behavior.failureSentinel) {
        await expect(
          fs.readFile(
            path.resolve(env.gateway.workspaceDir, behavior.failureSentinel.path),
            "utf8",
          ),
        ).rejects.toThrow();
      }
    },
  );
  it("uses fresh sessions for sequential native behaviors and repeated invocations", async () => {
    const env = await makeEnv();
    env.gateway.runtimeEnv.OPENCLAW_QA_FORCE_RUNTIME = "codex";
    let sessionIndex = 0;
    const requestedKeys: Array<string | undefined> = [];
    const createdKeys: string[] = [];
    const nativeBehaviorIds = ["bash", "exec", "grep"] as const;
    const createSession = vi.fn(async (_env: unknown, label: string, key?: string) => {
      requestedKeys.push(key);
      const phase = label.endsWith(" happy") ? "happy" : "failure";
      sessionIndex += 1;
      const sessionKey = `agent:qa:native-workspace:sequence:${sessionIndex}:${phase}`;
      createdKeys.push(sessionKey);
      return sessionKey;
    });
    const runAgentPrompt = vi.fn(
      async (
        _env: unknown,
        params: {
          sessionKey: string;
          message: string;
        },
      ) => {
        const behaviorId = nativeBehaviorIds.find((candidate) =>
          params.message.includes(`native-workspace-behavior=${candidate}.`),
        );
        if (!behaviorId) {
          throw new Error("native workspace behavior missing from prompt");
        }
        const behavior = getQaNativeWorkspaceBehavior(behaviorId);
        const phase = params.sessionKey.endsWith(":happy") ? "happy" : "failure";
        const args = phase === "happy" ? behavior.happyArgs : behavior.failureArgs;
        await writeQaSessionTranscript(env, params.sessionKey, [
          transcriptToolCall(behavior.nativeToolName, phase, {
            command: `/bin/zsh -lc ${JSON.stringify(args.cmd)}`,
          }),
          transcriptToolResult(
            behavior.nativeToolName,
            phase,
            phase === "happy"
              ? (behavior.happyOutputMarker ?? "native workspace command completed")
              : (behavior.failureOutputMarker ?? "path escapes workspace root"),
            phase === "failure" ? true : undefined,
          ),
        ]);
        return {};
      },
    );
    const deps = {
      createSession,
      readEffectiveTools: vi.fn(async () => new Set<string>()),
      runAgentPrompt,
      fetchJson: vi.fn(),
      ensureImageGenerationConfigured: vi.fn(),
    };

    for (const behaviorId of ["bash", "exec", "grep", "bash"] as const) {
      await expect(
        runRuntimeToolFixture(
          env,
          {
            toolName: OPENCLAW_TOOL_BY_BEHAVIOR[behaviorId],
            nativeWorkspaceBehavior: behaviorId,
            toolCoverage: {
              bucket: "codex-native-workspace",
              expectedLayer: "codex-native-workspace",
              required: true,
            },
          },
          deps,
        ),
      ).resolves.toContain(`codex-native ${behaviorId} behavior passed`);
    }

    expect(requestedKeys).toEqual(Array.from({ length: 8 }, () => undefined));
    expect(new Set(createdKeys).size).toBe(8);
  });
});
