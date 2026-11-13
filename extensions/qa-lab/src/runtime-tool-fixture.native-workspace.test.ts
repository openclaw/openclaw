import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import * as fixture from "../test/runtime-tool-fixture-helpers.js";
import {
  getQaNativeWorkspaceBehavior,
  type QaNativeWorkspaceBehavior,
  type QaNativeWorkspaceBehaviorId,
} from "./native-workspace-behavior.js";
import { readQaScenarioById } from "./scenario-catalog.js";
import { createSession } from "./suite-runtime-agent-session.js";

const configFor = (id: string) => readQaScenarioById(`runtime-tool-${id}`).execution.config!;

async function nativeFixture() {
  const sessionCreator = createSession;
  const env = await fixture.makeEnv();
  env.gateway.runtimeEnv.OPENCLAW_QA_FORCE_RUNTIME = "codex";
  const sessions: { label: string; created: string }[] = [];
  env.gateway.call = vi.fn(async (method, params) => {
    expect(method).toBe("sessions.create");
    const { label, key } = params as { label: string; key?: string };
    expect(key).toBeUndefined();
    const phase = label.endsWith(" happy") ? "happy" : "failure";
    const created = `agent:qa:native:${sessions.length}:${phase}`;
    sessions.push({ label, created });
    return { key: created };
  });
  return {
    env,
    sessions,
    run: (
      id: QaNativeWorkspaceBehaviorId,
      runAgentPrompt: fixture.RuntimeToolFixtureDeps["runAgentPrompt"] = async (_env, params) => {
        expect(params.message).toContain(`native-workspace-behavior=${id}.`);
        const phase = params.sessionKey.endsWith(":happy") ? "happy" : "failure";
        await fixture.writeQaSessionTranscript(
          env,
          params.sessionKey,
          nativeReceipt(getQaNativeWorkspaceBehavior(id), phase),
        );
        return {};
      },
    ) =>
      fixture.runRuntimeToolFixtureWithDeps(env, configFor(id), {
        ...fixture.runtimeToolFixtureDeps({ runAgentPrompt }),
        createSession: sessionCreator,
      }),
  };
}

function nativeReceipt(behavior: QaNativeWorkspaceBehavior, phase: "happy" | "failure") {
  const args = phase === "happy" ? behavior.happyArgs : behavior.failureArgs;
  const target = phase === "happy" ? behavior.happyMutation : behavior.failureSentinel;
  const input =
    behavior.nativeToolName === "bash"
      ? { command: `/bin/zsh -lc ${JSON.stringify(args.cmd)}` }
      : { changes: [{ path: target?.path, kind: { type: "update" } }] };
  return [
    fixture.transcriptToolCall(behavior.nativeToolName, phase, input),
    fixture.transcriptToolResult(
      behavior.nativeToolName,
      phase,
      phase === "happy"
        ? (behavior.happyOutputMarker ?? "native workspace change completed")
        : (behavior.failureOutputMarker ?? "path escapes workspace root"),
      phase === "failure" ? true : undefined,
    ),
  ];
}

afterEach(() => {
  vi.restoreAllMocks();
  resetPluginStateStoreForTests({ closeDatabase: false });
});
afterAll(fixture.cleanupRuntimeToolFixtureTempRoots);

it.each(["edit", "fs-write"] as const)(
  "requires correlated native receipts and observable %s outcomes",
  async (behaviorId) => {
    const { env, run } = await nativeFixture();
    const behavior = getQaNativeWorkspaceBehavior(behaviorId);
    const mutation = expectDefined(behavior.happyMutation, "native workspace mutation");
    const sentinel = expectDefined(behavior.failureSentinel, "outside-workspace sentinel");
    const readWorkspaceFile = (file: string) =>
      fs.readFile(path.resolve(env.gateway.workspaceDir, file), "utf8");
    const writeWorkspaceFile = (file: { path: string; contents: string }) =>
      fs.writeFile(path.resolve(env.gateway.workspaceDir, file.path), file.contents, "utf8");
    if (behaviorId === "fs-write") {
      await writeWorkspaceFile(mutation);
    }

    const promptEvidence: [string | undefined, boolean | undefined][] = [];
    const details = await run(behaviorId, async (_env, params) => {
      promptEvidence.push([
        params.transcriptToolName,
        params.requireSuccessfulTranscriptToolResult,
      ]);
      const phase = params.sessionKey.endsWith(":happy") ? "happy" : "failure";
      await fixture.writeQaSessionTranscript(
        env,
        params.sessionKey,
        nativeReceipt(behavior, phase),
      );
      if (behaviorId === "fs-write" && phase === "failure") {
        await expect(readWorkspaceFile(sentinel.path)).resolves.toBe(sentinel.contents);
      }
      if (phase === "happy") {
        if (behaviorId === "fs-write") {
          await expect(readWorkspaceFile(mutation.path)).rejects.toThrow();
        }
        await writeWorkspaceFile(mutation);
      }
      return {};
    });

    expect(promptEvidence).toEqual([
      [behavior.nativeToolName, true],
      [behavior.nativeToolName, undefined],
    ]);
    expect(details).toContain(`codex-native ${behaviorId} behavior passed`);
    await expect(readWorkspaceFile(mutation.path)).resolves.toBe(mutation.contents);
    await expect(readWorkspaceFile(sentinel.path)).rejects.toThrow();
  },
);
it("uses stable labels and fresh sessions across native fixtures", async () => {
  const { sessions, run } = await nativeFixture();
  for (const behaviorId of ["bash", "exec", "grep", "bash"] as const) {
    await expect(run(behaviorId)).resolves.toContain(`codex-native ${behaviorId} behavior passed`);
  }

  expect(new Set(sessions.map(({ created }) => created)).size).toBe(8);
  expect(sessions.map(({ label }) => label)).toEqual(
    ["bash", "exec", "grep", "bash"].flatMap((id) =>
      ["happy", "failure"].map((phase) => `Runtime tool fixture: ${id} ${phase}`),
    ),
  );
});
