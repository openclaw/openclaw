import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { runActiveReplySteer } from "../../auto-reply/reply/agent-runner-steer-adoption.js";
import { handleSteerCommand } from "../../auto-reply/reply/commands-steer.js";
import { buildCommandTestParams } from "../../auto-reply/reply/commands.test-harness.js";
import { createQueueTestRun } from "../../auto-reply/reply/queue.test-helpers.js";
import { resolveQueueSettingsCore } from "../../auto-reply/reply/queue/settings.js";
import { clearFollowupQueue } from "../../auto-reply/reply/queue/state.js";
import type { ReplyOperationRunState } from "../../auto-reply/reply/reply-operation-run-state.js";
import { prepareReplyToolAuthority } from "../../auto-reply/reply/reply-tool-authority.js";
import { resolveFollowupRunToolAuthorityFingerprintAsync } from "../../auto-reply/reply/reply-tool-authority.test-support.js";
import { createMockTypingController } from "../../auto-reply/reply/test-helpers.js";
import { createTypingSignaler } from "../../auto-reply/reply/typing-mode.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import {
  updateSessionEntry,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import * as sessionReads from "../../config/sessions/session-entry-read-runtime.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { CliBackendPlugin } from "../../plugins/cli-backend.types.js";
import type { InputProvenance } from "../../sessions/input-provenance.js";
import {
  beginReplyMessageInjectionTarget,
  captureCurrentReplyMessageInjectionTarget,
} from "../../sessions/session-controller.message-injection.js";
import { createReplyOperation } from "../../sessions/session-controller.operation.js";
import { steerSessionControllerOperation } from "../../sessions/session-controller.steer.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import {
  createTestUserTurnTranscriptTarget,
  readTranscriptMessages,
} from "../../sessions/user-turn-transcript.test-support.js";
import { loadBundledPluginFacade } from "../../test-utils/bundled-plugin-public-surface.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  createAdmittedRunOperatorAuthority,
  prepareSystemAgentRunAdmission,
  readRunOperatorAuthority,
} from "../admitted-run-context.js";
import { createDeferredEmbeddedRunLifecycleManager } from "../embedded-agent-runner/run/deferred-lifecycle-owner.js";
import {
  bindWorkerToolPreparation,
  prepareReplyToolAuthorityCallerRead,
} from "../harness/host-private-capabilities.js";
import { bindPreparedToolAuthority } from "../harness/tool-authority-preparation.js";
import { buildAgentInternalEventContext } from "../internal-events.js";
import { RUNTIME_EVENT_USER_PROMPT } from "../internal-runtime-context.js";
import { captureRequesterOrigin } from "../requester-origin.js";
import { executePluginOwnedProcess } from "./execute-plugin.js";
import { closePluginTestAdmissions, createExecution } from "./execute-plugin.test-support.js";
import { captureCliRunToolAuthority } from "./tool-authority.js";

const { buildAnthropicCliBackend } = await loadBundledPluginFacade<{
  buildAnthropicCliBackend: () => CliBackendPlugin;
}>({ pluginId: "anthropic", artifactBasename: "api.js" });

// One external process proves stdin delivery through the real public provider adapter.
// Native scheduling variants belong to the Anthropic transport's protocol matrix.
const CLI = String.raw`
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
const send = value => process.stdout.write(JSON.stringify(value) + "\n");
const inputs = new Map();
let initial = true;
for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  if (message.type === "control_request") {
    send({ type: "control_response", response: { subtype: "success", request_id: message.request_id, response: {} } });
  } else if (message.type === "user") {
    const text = message.message.content;
    appendFileSync("received.ndjson", JSON.stringify(text) + "\n");
    appendFileSync("received-origins.ndjson", JSON.stringify(message.isSynthetic === true) + "\n");
    inputs.set(message.uuid, { text, initial });
    if (initial) send({ type: "system", subtype: "init", capabilities: ["msg_lifecycle_v1"] });
    send({ type: "command_lifecycle", state: "started", command_uuid: message.uuid });
    send({ type: "control_request", request_id: message.uuid, request: {
      subtype: "hook_callback", callback_id: "UserPromptSubmit",
      input: { hook_event_name: "UserPromptSubmit", prompt: text },
    } });
    initial = false;
  } else if (message.type === "control_response") {
    const input = inputs.get(message.response.request_id);
    if (!input) continue;
    appendFileSync("received-contexts.ndjson", JSON.stringify(message.response.response) + "\n");
    if (input.text === "started-exit") process.exit(1);
    if (!input.initial) send({ type: "command_lifecycle", state: input.text === "started-cancelled" ? "cancelled" : "completed", command_uuid: message.response.request_id });
    send({ type: "system", subtype: "fixture_input", text: input.text });
    if (input.text === "finish") send({ type: "result", subtype: "success", is_error: false, result: "finished" });
  }
}
`;

afterEach(() => {
  closePluginTestAdmissions();
  clearRuntimeConfigSnapshot();
  vi.restoreAllMocks();
});

it("steers configured, session and explicit inputs through current authority into Claude stdin", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const root = state.workspaceDir;
    const sessionKey = "agent:main:main";
    const policyKey = "agent:main:claude-steering-policy";
    const config: OpenClawConfig = {
      commands: { text: true },
      agents: { defaults: { sandbox: { mode: "all" } }, entries: { main: {} } },
      tools: { sandbox: { tools: { deny: ["exec"] } }, exec: { security: "full", ask: "off" } },
    };
    // Storage consumes the runtime-prepared config, including in a fresh Bun worker.
    setRuntimeConfigSnapshot(config);
    const policyScope = { agentId: "main", sessionKey: policyKey };
    await upsertSessionEntryCore(policyScope, {
      sessionId: "policy",
      updatedAt: 1,
      sandboxMode: "off",
    });
    const { context } = await createExecution({ config, timeoutMs: 30_000 });
    const { params } = context;
    const { sessionId } = params;
    Object.assign(params, {
      sessionKey,
      runtimePolicySessionKey: policyKey,
      workspaceDir: root,
      cwd: root,
      messageProvider: "webchat",
      senderId: "owner",
      senderIsOwner: true,
      traceAuthorized: false,
    });
    let rejectSourceCleanup = false;
    params.assertCurrent = Object.assign(() => {}, {
      prepareSessionSourceScope: async () => ({
        checks: [],
        assertCurrent: () => {},
        release: () => {
          if (rejectSourceCleanup) {
            throw new Error("Source scope cleanup failed after stdin submission");
          }
        },
      }),
    });
    context.workspaceDir = root;
    context.cwd = root;
    params.inputProvenance = { kind: "internal_system", sourceTool: "future_wake" };
    const recordInput = (text: string, provenance?: InputProvenance) =>
      createUserTurnTranscriptRecorder({
        input: { text, idempotencyKey: text, provenance },
        target: createTestUserTurnTranscriptTarget({ sessionKey, sessionId, cwd: root }),
      });
    const followupRun = createQueueTestRun({ prompt: "initial", originatingChannel: "webchat" });
    Object.assign(followupRun.run, params);
    const operation = createReplyOperation({ sessionKey, sessionId, resetTriggered: false });
    await operation.bindToolAuthoritySnapshotAsync(prepareReplyToolAuthority(followupRun));
    const fingerprint = await operation.bindToolAuthorityRouteAsync(followupRun.run);
    Object.assign(params, { toolAuthorityFingerprint: fingerprint, replyOperation: operation });
    operation.setPhase("running");
    const fixture = path.join(root, "claude-steering.mjs");
    await writeFile(fixture, CLI);
    const prepared = await buildAnthropicCliBackend().prepareExecution?.({
      workspaceDir: root,
      provider: "claude-cli",
      modelId: context.normalizedModel,
      executionMode: "agent",
      config,
    });
    const execute = expectDefined(prepared?.execute, "Claude native transport");
    const ready = createDeferred();
    const cleanupInputObserved = createDeferred();
    const completionObserved = createDeferred();
    const observations = new Map([
      ["initial", ready],
      ["post-submit-cleanup", cleanupInputObserved],
      [RUNTIME_EVENT_USER_PROMPT, completionObserved],
    ]);
    const run = executePluginOwnedProcess({
      context,
      execute,
      executionCommand: process.execPath,
      executionArgs: [fixture],
      env: { PATH: process.env.PATH ?? "", HOME: root, CLAUDE_CONFIG_DIR: root },
      prompt: "initial",
      useResume: false,
      noOutputTimeoutMs: 30_000,
      consumeStdout: (chunk) => {
        const record = JSON.parse(chunk);
        if (record.subtype === "fixture_input") {
          observations.get(record.text)?.resolve();
        }
      },
    });
    const settled = run.catch((error: unknown) => error);
    const readInputs = async () =>
      (await readFile(path.join(root, "received.ndjson"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
    try {
      await Promise.race([
        ready.promise,
        run.then(() => {
          throw new Error("Native turn ended before readiness");
        }),
      ]);
      const target = expectDefined(
        captureCurrentReplyMessageInjectionTarget(sessionKey),
        "Claude registry input sink",
      );
      const guestFingerprint = await resolveFollowupRunToolAuthorityFingerprintAsync({
        ...followupRun,
        toolsAllow: ["read"],
        run: { ...followupRun.run, senderId: "guest", senderIsOwner: false },
      });
      expect(guestFingerprint).not.toBe(fingerprint);
      const mismatch = await beginReplyMessageInjectionTarget(target, "different principal", {
        isInboundUserMessage: true,
        toolAuthorityFingerprint: guestFingerprint,
      });
      await expect(mismatch.outcome).resolves.toMatchObject({
        status: "rejected",
        reason: "tool_authority_mismatch",
      });
      expect(await readInputs()).toEqual(["initial"]);

      const typing = createMockTypingController();
      const followup = vi.fn(async () => {});
      const routes = [
        { text: "global", queue: { mode: "steer" as const } },
        {
          text: "channel",
          queue: { mode: "followup" as const, byChannel: { webchat: "steer" as const } },
        },
        { text: "session", queue: { mode: "collect" as const }, sessionMode: "steer" as const },
        { text: "explicit steer", queue: { mode: "followup" as const }, command: "/steer" },
        { text: "explicit tell", queue: { mode: "collect" as const }, command: "/tell" },
        { text: "started-cancelled", queue: { mode: "steer" as const } },
      ];
      const routeInputs = routes.map((route) => route.text);
      const webchatContext = { Provider: "webchat", Surface: "webchat", SessionKey: sessionKey };
      for (const route of routes) {
        const cfg = { ...config, messages: { queue: route.queue } };
        let inlineMode: "steer" | undefined;
        if (route.command) {
          const commandParams = buildCommandTestParams(
            route.command + " " + route.text,
            cfg,
            webchatContext,
            { workspaceDir: root },
          );
          const result = await handleSteerCommand(commandParams, true);
          expect(result).toMatchObject({ shouldContinue: true, queueModeOverride: "steer" });
          expect(commandParams.ctx.BodyForAgent).toBe(route.text);
          inlineMode = result?.queueModeOverride === "steer" ? "steer" : undefined;
        }
        const resolvedQueue = resolveQueueSettingsCore({
          cfg,
          channel: "webchat",
          inlineMode,
          sessionEntry: route.sessionMode
            ? { sessionId, updatedAt: 1, queueMode: route.sessionMode }
            : undefined,
        });
        expect(resolvedQueue.mode).toBe("steer");
        const recorder = recordInput(route.text);
        const incoming = {
          ...followupRun,
          prompt: route.text,
          messageId: route.text,
          userTurnTranscriptRecorder: recorder,
        };
        const resultState: ReplyOperationRunState = {};
        await expect(
          runActiveReplySteer({
            followupRun: incoming,
            opts: { runId: route.text },
            providedReplyOperation: operation,
            queueKey: sessionKey,
            replyOperationRunState: resultState,
            resolvedQueue,
            sourceTurnId: undefined,
            runFollowup: followup,
            sessionCtx: {},
            sessionKey,
            touchActiveSessionEntry: async () => {},
            typingSignals: createTypingSignaler({ typing, mode: "never" }),
          }),
        ).resolves.toBe("handled");
        expect(resultState.admission).toEqual({ status: "accepted", mode: "steer" });
        expect(recorder.hasPersisted()).toBe(true);
      }
      expect(followup).not.toHaveBeenCalled();
      expect(await readInputs()).toEqual(["initial", ...routeInputs]);

      // A forwarded completion steered into the running turn keeps its own origin and context.
      const completion = recordInput(RUNTIME_EVENT_USER_PROMPT, {
        kind: "inter_session",
        sourceTool: "subagent_announce",
      });
      const fragments = buildAgentInternalEventContext([
        {
          type: "task_completion",
          source: "subagent",
          childSessionKey: "agent:main:subagent:proof",
          announceType: "subagent task",
          taskLabel: "Check fixtures",
          status: "ok",
          statusLabel: "completed",
          result: "The fixture count is 42.",
          replyInstruction: "Summarize the result for the requester.",
        },
      ]);
      const text = fragments.map((part) => part.text).join("\n\n");
      const queuedCompletion = await beginReplyMessageInjectionTarget(
        target,
        RUNTIME_EVENT_USER_PROMPT,
        { userTurnTranscriptRecorder: completion, currentInboundContext: { text, fragments } },
      );
      await expect(queuedCompletion.outcome).resolves.toMatchObject({ status: "accepted" });
      await completionObserved.promise;
      routeInputs.push(RUNTIME_EVENT_USER_PROMPT);
      const readLines = async (name: string) =>
        (await readFile(path.join(root, name), "utf8"))
          .trim()
          .split("\n")
          .map((l) => JSON.parse(l));
      const contexts = await readLines("received-contexts.ndjson");
      expect(contexts.at(-1)?.hookSpecificOutput?.additionalContext).toContain(
        "The fixture count is 42.",
      );
      expect(await readInputs()).toEqual(["initial", ...routeInputs]);
      // Initial host turn, human steers, then the forwarded completion.
      expect(await readLines("received-origins.ndjson")).toEqual([
        true,
        ...routes.map(() => false),
        true,
      ]);

      // A recorder failure before native acceptance rejects the input instead of losing it.
      const unresolvedRecorder = recordInput("unresolved input");
      vi.spyOn(unresolvedRecorder, "resolveMessage").mockRejectedValueOnce(new Error("preflight"));
      const unresolved = await beginReplyMessageInjectionTarget(target, "unresolved input", {
        userTurnTranscriptRecorder: unresolvedRecorder,
      });
      await expect(unresolved.outcome).resolves.toMatchObject({ status: "rejected" });
      expect(await readInputs()).toEqual(["initial", ...routeInputs]);
      expect(unresolvedRecorder.hasPersisted()).toBe(false);

      // Revoke stored policy after selection but before the ordered final worker read.
      const read = sessionReads.withSessionEntriesFromStoresInWorker;
      let revoked = false;
      vi.spyOn(sessionReads, "withSessionEntriesFromStoresInWorker").mockImplementation(
        async (inputs, consume, options) => {
          if (options?.ordered && !revoked) {
            revoked = true;
            await updateSessionEntry(policyScope, () => ({ sandboxMode: undefined }));
          }
          return read(inputs, consume, options);
        },
      );
      const assertCurrent = () => operation.abortSignal.throwIfAborted();
      const refused = await beginReplyMessageInjectionTarget(target, "revoked policy", {
        isInboundUserMessage: true,
        toolAuthorityFingerprint: fingerprint,
        toolAuthorityPreparation: bindPreparedToolAuthority(
          bindWorkerToolPreparation({
            assertCurrent,
            compatAssertCurrent: () => {
              throw new Error("Expected worker-prepared Claude input");
            },
            prepareCurrent: async () => {
              const authorityRead = expectDefined(
                await prepareReplyToolAuthorityCallerRead(
                  operation.projectToolAuthorityFingerprintAsync,
                  undefined,
                  fingerprint,
                  followupRun.run,
                  assertCurrent,
                ),
                "worker-prepared Claude input policy",
              );
              await authorityRead.prepareCurrent();
            },
          }),
        ),
      });
      await expect(refused.acceptance).resolves.toBe(false);
      const refusal = await refused.outcome;
      expect(revoked, JSON.stringify(refusal)).toBe(true);
      // Changed execution policy leaves unconsumed input eligible for a fresh followup.
      expect(refusal).toMatchObject({ status: "rejected", reason: "tool_authority_mismatch" });
      expect(await readInputs()).toEqual(["initial", ...routeInputs]);
      vi.restoreAllMocks();
      rejectSourceCleanup = true;
      const uncertain = await beginReplyMessageInjectionTarget(target, "post-submit-cleanup");
      await expect(uncertain.acceptance).resolves.toBe(true);
      await expect(uncertain.outcome).resolves.toMatchObject({ status: "indeterminate" });
      rejectSourceCleanup = false;
      await cleanupInputObserved.promise;
      const exitRecorder = recordInput("started-exit");
      const exit = await beginReplyMessageInjectionTarget(target, "started-exit", {
        userTurnTranscriptRecorder: exitRecorder,
      });
      await expect(exit.acceptance).resolves.toBe(true);
      await expect(exit.outcome).resolves.toMatchObject({ status: "accepted" });
      await expect(run).rejects.toThrow();
      const expectedInputs = [...routeInputs, "started-exit"];
      expect(await readInputs()).toEqual([
        "initial",
        ...routeInputs,
        "post-submit-cleanup",
        "started-exit",
      ]);
      expect(exitRecorder.hasPersisted()).toBe(true);
      const messages = await readTranscriptMessages({
        sessionId,
        sessionKey,
        storePath: resolveSessionStorePathCore(undefined, { agentId: "main" }),
      });
      expect(messages.map((message) => message.content)).toEqual(expectedInputs);
      expect(followup).not.toHaveBeenCalled();
    } finally {
      operation.abortByUser();
      await settled;
      operation.complete();
      clearFollowupQueue(sessionKey);
      await prepared?.cleanup?.();
    }
  });
});

it("steers a spawned Claude child for its requester and refuses other sources", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const root = state.workspaceDir;
    const requesterKey = "agent:main:dashboard:coordinator";
    const childKey = "agent:main:subagent:claude-child";
    const config: OpenClawConfig = { tools: { exec: { security: "full", ask: "off" } } };
    const { context } = await createExecution({ config, timeoutMs: 30_000 });
    const { params } = context;
    const { sessionId } = params;
    let revoked = false;
    // Spawn admits the child with the requester's operator source and origin.
    const operatorAuthority = createAdmittedRunOperatorAuthority({
      profileId: "owner",
      scopes: ["operator.read", "operator.write"],
      gatewayAccessGrant: null,
      assertCurrent: () => {
        if (revoked) {
          throw new Error("operator source revoked");
        }
      },
    });
    const admission = prepareSystemAgentRunAdmission(
      config,
      params.runId,
      "main",
      "spawned-child",
      undefined,
      operatorAuthority,
    );
    const requesterOrigin = expectDefined(
      captureRequesterOrigin({
        sessionKey: requesterKey,
        operatorProfileId: "owner",
        messageProvider: "webchat",
      }),
      "requester origin",
    );
    const operation = createReplyOperation({
      sessionKey: childKey,
      sessionId,
      resetTriggered: false,
      turnKind: "direct",
    });
    Object.assign(params, {
      admittedRunContext: await admission.admit("plugin-harness"),
      sessionKey: childKey,
      spawnedBy: requesterKey,
      requesterOrigin,
      workspaceDir: root,
      cwd: root,
      replyOperation: operation,
    });
    context.workspaceDir = root;
    context.cwd = root;
    // Same binding CLI preparation gives a direct child turn.
    using callerAuthority = captureCliRunToolAuthority(params, {
      agentId: "main",
      workspaceDir: root,
      cwd: root,
    });
    const { fingerprint } = await callerAuthority.bindQuestions(
      { provider: params.provider, model: context.modelId },
      () => readRunOperatorAuthority(params),
    );
    params.toolAuthorityFingerprint = fingerprint;
    operation.setPhase("running");
    // Session lanes hand the turn to the CLI through a placeholder native owner.
    const lifecycle = createDeferredEmbeddedRunLifecycleManager({
      runId: params.runId,
      sessionId,
      sessionKey: childKey,
      replyOperation: operation,
    });
    lifecycle.handoffToCli();
    const fixture = path.join(root, "claude-child.mjs");
    await writeFile(fixture, CLI);
    const prepared = await buildAnthropicCliBackend().prepareExecution?.({
      workspaceDir: root,
      provider: "claude-cli",
      modelId: context.normalizedModel,
      executionMode: "agent",
      config,
    });
    const execute = expectDefined(prepared?.execute, "Claude native transport");
    const ready = createDeferred();
    const run = executePluginOwnedProcess({
      context,
      execute,
      executionCommand: process.execPath,
      executionArgs: [fixture],
      env: { PATH: process.env.PATH ?? "", HOME: root, CLAUDE_CONFIG_DIR: root },
      prompt: "initial",
      useResume: false,
      noOutputTimeoutMs: 30_000,
      consumeStdout: (chunk) => {
        if (JSON.parse(chunk).text === "initial") {
          ready.resolve();
        }
      },
    });
    const settled = run.catch((error: unknown) => error);
    const readInputs = async () =>
      (await readFile(path.join(root, "received.ndjson"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
    // The sessions_send steering request, as its delivery owner builds it.
    const steer = (
      text: string,
      origin: typeof requesterOrigin = requesterOrigin,
      requesterConfig = config,
    ) =>
      steerSessionControllerOperation({
        operation,
        text,
        abortOnUnconfirmedTranscript: false,
        options: {
          requesterToolAuthority: { requesterOrigin: origin, config: requesterConfig },
          steeringMode: "all",
          debounceMs: 0,
          waitForTranscriptCommit: true,
          userTurnTranscriptRecorder: createUserTurnTranscriptRecorder({
            input: { text, requesterOrigin: origin, idempotencyKey: text },
            target: createTestUserTurnTranscriptTarget({ sessionKey: childKey, sessionId }),
          }),
        },
      });
    try {
      await ready.promise;
      await expect(steer("guidance")).resolves.toMatchObject({ status: "accepted" });
      expect(await readInputs()).toEqual(["initial", "guidance"]);
      await expect(
        steer("other human", { ...requesterOrigin, operatorProfileId: "guest" }),
      ).resolves.toMatchObject({ status: "rejected", reason: "requester_origin_mismatch" });
      await expect(
        steer("other policy", requesterOrigin, {
          ...config,
          tools: { ...config.tools, deny: ["read"] },
        }),
      ).resolves.toMatchObject({ status: "rejected", reason: "tool_authority_mismatch" });
      revoked = true;
      await expect(steer("revoked source")).resolves.toMatchObject({ status: "rejected" });
      expect(await readInputs()).toEqual(["initial", "guidance"]);
    } finally {
      operation.abortByUser();
      await settled;
      await lifecycle.complete();
      operation.complete();
      admission.close();
      await prepared?.cleanup?.();
    }
  });
});
