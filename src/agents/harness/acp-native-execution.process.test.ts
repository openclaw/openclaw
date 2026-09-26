import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it, vi } from "vitest";
import { waitForFixtureFile } from "../../../test/helpers/process-wait.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  buildExternalRunFailureReply,
  buildKnownAgentRunFailureReplyPayload,
} from "../../auto-reply/reply/agent-runner-failure-reply.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { onAgentEventForRun, type AgentEventPayload } from "../../infra/agent-events.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { upsertSessionEntry } from "../../plugin-sdk/session-store-runtime.js";
import {
  appendSessionTranscriptMessageByIdentityStrict,
  readVisibleSessionTranscriptMessageEntries,
} from "../../plugin-sdk/session-transcript-runtime.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  attemptFor,
  registerNative,
  useNativeProcessFixture,
} from "./acp-native-process.test-support.js";
import { getRegisteredAgentHarness } from "./registry.js";
import { runAgentHarnessAttempt } from "./selection.js";

useNativeProcessFixture();

type PeerState = { history: string[]; currentModelId: string; modelChanges: string[] };
async function peerStates(directory: string): Promise<PeerState[]> {
  const names = (await fs.readdir(directory)).filter((name) => name.endsWith(".json"));
  return Promise.all(
    names.map(async (name) => JSON.parse(await fs.readFile(path.join(directory, name), "utf8"))),
  );
}

const policyCases = [
  { agent: "opencode", profile: "full", alsoAllow: undefined, denied: false },
  { agent: "opencode", profile: "messaging", alsoAllow: undefined, denied: true },
  { agent: "opencode", profile: "minimal", alsoAllow: undefined, denied: true },
  { agent: "kilocode", profile: "coding", alsoAllow: undefined, denied: true },
  { agent: "kilocode", profile: "coding", alsoAllow: ["message"], denied: false },
] satisfies Array<{
  agent: string;
  profile: NonNullable<OpenClawConfig["tools"]>["profile"];
  alsoAllow: string[] | undefined;
  denied: boolean;
}>;
it.each(policyCases)(
  "admits $agent profile=$profile alsoAllow=$alsoAllow before native effects",
  async ({ agent, profile, alsoAllow, denied }) => {
    await withOpenClawTestState({ label: "acp-native-policy" }, async (state) => {
      const config: OpenClawConfig = {
        session: { store: path.join(state.sessionsDir(), "sessions.json") },
        tools: { profile, alsoAllow },
      };
      const native = await registerNative(state, config, "owner-agent.mjs");
      const attempt = await attemptFor(state, config, agent, "full");
      try {
        if (!denied) {
          await appendSessionTranscriptMessageByIdentityStrict({
            ...attempt.target,
            message: { role: "user", content: "Earlier conversation", timestamp: Date.now() },
          });
          attempt.input.currentInboundContext = { text: "Channel context", promptJoiner: "\n" };
        }
        const outcome = await runAgentHarnessAttempt(attempt.input).then(
          (value) => ({ value, error: undefined }),
          (error: unknown) => ({ value: undefined, error }),
        );
        const records = await peerStates(native.peerDirectory);
        const effects = await fs.readdir(path.join(native.peerDirectory, "effects"));
        if (denied) {
          expect.soft(outcome.error).toMatchObject({
            message: expect.stringContaining("cannot enforce this conversation's tool policy"),
          });
          expect.soft(records).toEqual([]);
          expect.soft(effects).toEqual([]);
          const reply = buildExternalRunFailureReply({
            message: formatErrorMessage(outcome.error),
            error: outcome.error,
          });
          expect.soft(reply.text).toContain("cannot run with this chat's tool restrictions");
          expect.soft(reply.text).toContain("Choose a different model provider");
          expect.soft(reply.text).not.toContain("try again");
          expect.soft(reply.text).not.toContain("/new");
          expect.soft(reply.isGenericRunnerFailure).toBe(false);
          expect
            .soft(
              buildKnownAgentRunFailureReplyPayload({
                err: outcome.error,
                sessionCtx: { Provider: "discord", Surface: "discord", ChatType: "group" },
                resolvedVerboseLevel: "off",
              }),
            )
            .toMatchObject({ text: reply.text, isError: true });
        } else {
          expect.soft(outcome.error).toBeUndefined();
          expect.soft(outcome.value?.terminal).toMatchObject({ kind: "ok" });
          expect.soft(records).toHaveLength(1);
          expect.soft(records[0]?.history).toHaveLength(1);
          expect(records[0]?.history[0]).toContain("Earlier conversation");
          expect(records[0]?.history[0]).toContain(
            "Current turn:\nChannel context\nRecord the requested native effect.",
          );
          expect(outcome.value?.assistantTexts).toEqual([
            expect.stringContaining("Record the requested native effect."),
          ]);
          const transcript = await readVisibleSessionTranscriptMessageEntries(attempt.target);
          expect(transcript.map((row) => row.role)).toEqual(["user", "user", "assistant"]);
          const assistant = transcript.find((row) => row.role === "assistant");
          expect(assistant?.message).toEqual(outcome.value?.currentAttemptAssistant);
          expect(assistant?.idempotencyKey).toBe(outcome.value?.assistantTranscriptIdempotencyKey);
          expect.soft(effects).toHaveLength(1);
          const harness = getRegisteredAgentHarness(`acp-${agent}`)?.harness;
          if (!harness?.loadModelCatalog) {
            throw new Error("Native catalog operation missing");
          }
          expect(
            await harness.loadModelCatalog({
              config,
              agentId: "main",
              agentDir: state.agentDir(),
              workspaceDir: state.workspaceDir,
            }),
          ).toEqual({
            entries: [
              {
                provider: `acp-${agent}`,
                id: "initial",
                name: "Initial",
                nativeRuntime: `acp-${agent}`,
              },
              {
                provider: `acp-${agent}`,
                id: "selected",
                name: "Selected",
                nativeRuntime: `acp-${agent}`,
              },
            ],
            outcomes: [{ provider: `acp-${agent}`, status: "ready" }],
          });
          expect(await readVisibleSessionTranscriptMessageEntries(attempt.target)).toEqual(
            transcript,
          );
          expect(await fs.readdir(path.join(native.peerDirectory, "effects"))).toEqual(effects);
        }
      } finally {
        attempt.close();
        await native.service.stop?.(native.context);
      }
    });
  },
  60000,
);

it.each(["complete", "revoke"] as const)(
  "publishes native assistant progress before final response and fences late output: %s",
  async (completion) => {
    await withOpenClawTestState({ label: "acp-native-stream" }, async (state) => {
      const config: OpenClawConfig = {
        session: { store: path.join(state.sessionsDir(), "sessions.json") },
      };
      const native = await registerNative(state, config, "owner-agent.mjs", {
        holdPromptReply: true,
      });
      const attempt = await attemptFor(state, config, "opencode", "full");
      const updates: AgentEventPayload[] = [];
      const unsubscribe = onAgentEventForRun(attempt.input.runId, (event) => {
        if (event.stream === "assistant") {
          updates.push(event);
        }
      });
      let finished = false;
      const run = runAgentHarnessAttempt(attempt.input).finally(() => {
        finished = true;
      });
      void run.catch(() => {});
      try {
        await waitForFixtureFile(path.join(native.peerDirectory, "prompt-reply-entered"), run);
        await expect.poll(() => updates.at(-1)?.data.text).toBe("First chunk");
        expect(finished).toBe(false);
        expect(updates[0]?.sessionKey).toBe(attempt.target.sessionKey);
        if (completion === "revoke") {
          attempt.close();
        }
        await fs.writeFile(path.join(native.peerDirectory, "prompt-reply-release"), "release");
        const result = await run;
        expect(result.terminal.kind).toBe(completion === "complete" ? "ok" : "failed");
        expect(updates.map((event) => event.data.delta)).toEqual(
          completion === "complete" ? ["First chunk", " second chunk"] : ["First chunk"],
        );
      } finally {
        await fs.writeFile(path.join(native.peerDirectory, "prompt-reply-release"), "release");
        await Promise.allSettled([run]);
        unsubscribe();
        attempt.close();
        await native.service.stop?.(native.context);
      }
    });
  },
  60000,
);

it.each([
  { operation: "model", kind: "revoke" },
  { operation: "model", kind: "active" },
  { operation: "prompt", kind: "revoke" },
  { operation: "prompt", kind: "active" },
] as const)(
  "preserves native $operation authority while a real control is queued: $kind",
  async ({ operation, kind }) => {
    await withOpenClawTestState({ label: "acp-native-control-authority" }, async (state) => {
      const config: OpenClawConfig = {
        session: { store: path.join(state.sessionsDir(), "sessions.json") },
      };
      const native = await registerNative(state, config, "owner-agent.mjs", {
        holdModeControl: true,
      });
      const attempt = await attemptFor(state, config, "opencode", "full");
      let holdingControl: Promise<void> | undefined;
      let run: ReturnType<typeof runAgentHarnessAttempt> | undefined;
      try {
        const runtime = await native.service.getRuntime(native.context);
        const nativeTarget = {
          agentId: "main",
          sessionKey: `agent:main:harness:acp-opencode:${attempt.input.sessionId}`,
          agent: "opencode",
          cwd: state.workspaceDir,
          mode: "persistent" as const,
          bridgeSession: {
            agentId: "main",
            sessionKey: attempt.target.sessionKey,
            native: true,
          },
          model: operation === "model" ? "initial" : "selected",
          modelExplicit: true,
        };
        const handle = await runtime.ensureSession(nativeTarget);
        const getStatus = runtime.getStatus.bind(runtime);
        const initial = await getStatus({ handle });
        expect(initial.models?.currentModelId).toBe(nativeTarget.model);
        const before = await peerStates(native.peerDirectory);
        holdingControl = runtime.setMode({ handle, mode: "review" });
        void holdingControl.catch(() => {});
        await waitForFixtureFile(
          path.join(native.peerDirectory, "mode-control-entered"),
          holdingControl,
          "review",
        );
        const require = createRequire(
          new URL("../../../extensions/acpx/package.json", import.meta.url),
        );
        const upstream: typeof import("acpx/runtime") = await import(
          pathToFileURL(require.resolve("acpx/runtime")).href
        );
        const upstreamOperation =
          operation === "model"
            ? vi.spyOn(upstream.AcpxRuntime.prototype, "setModel")
            : vi.spyOn(upstream.AcpxRuntime.prototype, "startTurn");
        // The warmed manager queues this call before polling returns; the earlier native control stays held.
        run = runAgentHarnessAttempt(attempt.input);
        void run.catch(() => {});
        await Promise.race([
          expect.poll(() => upstreamOperation.mock.calls.length).toBe(1),
          run.then((result) => {
            throw new Error(`Attempt ended before native ${operation} boundary`, { cause: result });
          }),
        ]);
        if (kind === "revoke") {
          attempt.close();
        }
        await fs.writeFile(path.join(native.peerDirectory, "mode-control-release"), "release");
        await holdingControl;
        const outcome = await run;
        const records = await peerStates(native.peerDirectory);
        const effects = await fs.readdir(path.join(native.peerDirectory, "effects"));
        const persisted = await getStatus({ handle });
        if (kind === "active") {
          expect.soft(outcome?.terminal).toMatchObject({ kind: "ok" });
          expect.soft(persisted.models?.currentModelId).toBe("selected");
          expect.soft(records[0]?.currentModelId).toBe("selected");
          expect.soft(records[0]?.modelChanges).toEqual(["selected"]);
          expect.soft(records[0]?.history).toHaveLength(1);
          expect.soft(effects).toHaveLength(1);
        } else {
          expect.soft(outcome?.terminal).toMatchObject({
            kind: "failed",
          });
          expect.soft(persisted.models?.currentModelId).toBe(nativeTarget.model);
          expect.soft(records[0]?.currentModelId).toBe(nativeTarget.model);
          expect.soft(records[0]?.modelChanges).toEqual(before[0]?.modelChanges);
          expect.soft(records[0]?.history).toEqual(before[0]?.history);
          expect.soft(effects).toEqual([]);
        }
      } finally {
        await fs.writeFile(path.join(native.peerDirectory, "mode-control-release"), "release");
        await Promise.allSettled([
          ...(run ? [run] : []),
          ...(holdingControl ? [holdingControl] : []),
        ]);
        attempt.close();
        await native.service.stop?.(native.context);
      }
    });
  },
  60000,
);

it.each([
  { agent: "opencode", kind: "active" },
  { agent: "qwen", kind: "active" },
  { agent: "pi", kind: "active" },
  { agent: "kilocode", kind: "active" },
  { agent: "opencode", kind: "cancel" },
  { agent: "opencode", kind: "timeout" },
  { agent: "opencode", kind: "revoke" },
] as const)(
  "preserves $agent model authority during cold session initialization: $kind",
  async ({ agent, kind }) => {
    await withOpenClawTestState({ label: "acp-native-cold-authority" }, async (state) => {
      const config: OpenClawConfig = {
        session: { store: path.join(state.sessionsDir(), "sessions.json") },
      };
      const native = await registerNative(state, config, "owner-agent.mjs", {
        holdNewSession: true,
      });
      const attempt = await attemptFor(state, config, agent, "full");
      const controller = new AbortController();
      attempt.input.abortSignal = controller.signal;
      const timedOut = createDeferred();
      if (kind === "timeout") {
        attempt.input.timeoutMs = 3000;
        attempt.input.onAttemptTimeout = () => timedOut.resolve();
      }
      const run = runAgentHarnessAttempt(attempt.input);
      void run.catch(() => {});
      try {
        await waitForFixtureFile(path.join(native.peerDirectory, "session-new-entered"), run);
        const transcriptBeforeRelease = await readVisibleSessionTranscriptMessageEntries(
          attempt.target,
        );
        if (kind === "cancel") {
          controller.abort();
        } else if (kind === "revoke") {
          attempt.close();
        } else if (kind === "timeout") {
          await timedOut.promise;
        }
        await fs.writeFile(path.join(native.peerDirectory, "session-new-release"), "release");
        const outcome = await run;
        const records = await peerStates(native.peerDirectory);
        const effects = await fs.readdir(path.join(native.peerDirectory, "effects"));
        expect(records).toHaveLength(1);
        if (kind === "active") {
          expect.soft(outcome?.terminal).toMatchObject({ kind: "ok" });
          expect.soft(records[0]?.currentModelId).toBe("selected");
          expect.soft(records[0]?.modelChanges).toEqual(["selected"]);
          expect.soft(records[0]?.history).toHaveLength(1);
          expect.soft(effects).toHaveLength(1);
        } else {
          expect.soft(outcome?.terminal).toMatchObject({
            kind: kind === "cancel" ? "aborted" : kind === "revoke" ? "failed" : "timeout",
          });
          expect.soft(records[0]?.currentModelId).toBe("initial");
          expect.soft(records[0]?.modelChanges).toEqual([]);
          expect.soft(records[0]?.history).toEqual([]);
          expect.soft(effects).toEqual([]);
          expect
            .soft(await readVisibleSessionTranscriptMessageEntries(attempt.target))
            .toEqual(transcriptBeforeRelease);
        }
      } finally {
        await fs.writeFile(path.join(native.peerDirectory, "session-new-release"), "release");
        await Promise.allSettled([run]);
        attempt.close();
        await native.service.stop?.(native.context);
      }
    });
  },
  60000,
);

it.each([
  {
    label: "sandbox with unrestricted tool names",
    config: {
      agents: { defaults: { sandbox: { mode: "all" as const } } },
      tools: { profile: "full" as const, sandbox: { tools: { allow: ["*"], deny: [] } } },
    },
    reason: "outside the sandbox",
  },
  {
    label: "configured node execution",
    config: { tools: { profile: "full" as const, exec: { host: "node" as const } } },
    reason: "remote execution",
  },
  {
    label: "workspace-only files",
    config: { tools: { profile: "full" as const, fs: { workspaceOnly: true } } },
    reason: "workspace-only",
  },
])(
  "rejects host-only ACP before native effects: $label",
  async ({ config: restrictions, reason }) => {
    await withOpenClawTestState({ label: "acp-native-containment" }, async (state) => {
      const config: OpenClawConfig = {
        ...restrictions,
        session: { store: path.join(state.sessionsDir(), "sessions.json") },
      };
      const native = await registerNative(state, config, "owner-agent.mjs");
      const attempt = await attemptFor(state, config, "opencode", "full");
      try {
        await expect(runAgentHarnessAttempt(attempt.input)).rejects.toThrow(reason);
        expect(await peerStates(native.peerDirectory)).toEqual([]);
        expect(await fs.readdir(path.join(native.peerDirectory, "effects"))).toEqual([]);
      } finally {
        attempt.close();
        await native.service.stop?.(native.context);
      }
    });
  },
  60000,
);

it.each([
  { consent: "acp-opencode", mandatorySandbox: undefined, permitted: true },
  { consent: "acp-kilocode", mandatorySandbox: undefined, permitted: false },
  { consent: "acp-opencode", mandatorySandbox: "session", permitted: false },
  { consent: "acp-opencode", mandatorySandbox: "exec", permitted: false },
])(
  "uses exact native consent=$consent with mandatorySandbox=$mandatorySandbox",
  async ({ consent, mandatorySandbox, permitted }) => {
    await withOpenClawTestState({ label: "acp-native-consent" }, async (state) => {
      const config: OpenClawConfig = {
        session: { store: path.join(state.sessionsDir(), "sessions.json") },
        tools: {
          profile: "full",
          deny: ["browser"],
          ...(mandatorySandbox === "exec" ? { exec: { host: "sandbox" as const } } : {}),
        },
      };
      const native = await registerNative(state, config, "owner-agent.mjs");
      const attempt = await attemptFor(state, config, "opencode", "full");
      try {
        await upsertSessionEntry({
          ...attempt.target,
          entry: {
            sessionId: attempt.target.sessionId,
            updatedAt: Date.now(),
            agentRuntimeOverride: "acp-opencode",
            nativeRuntimeConsent: consent,
            permissionMode: "full",
            sandboxMode: "off",
            ...(mandatorySandbox === "session" ? { sandbox: "required" as const } : {}),
          },
        });
        if (permitted) {
          const result = await runAgentHarnessAttempt(attempt.input);
          expect(result.terminal.kind).toBe("ok");
          const effects = await fs.readdir(path.join(native.peerDirectory, "effects"));
          expect(effects).toHaveLength(1);
          expect(
            await fs.readFile(path.join(native.peerDirectory, "effects", effects[0]!), "utf8"),
          ).toContain("Record the requested native effect.");
          expect(config.tools?.deny).toEqual(["browser"]);
        } else {
          await expect(runAgentHarnessAttempt(attempt.input)).rejects.toThrow(
            mandatorySandbox
              ? "requires a sandbox"
              : "cannot enforce this conversation's tool policy",
          );
          expect(await fs.readdir(path.join(native.peerDirectory, "effects"))).toEqual([]);
        }
      } finally {
        attempt.close();
        await native.service.stop?.(native.context);
      }
    });
  },
  60000,
);
