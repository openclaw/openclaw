import path from "node:path";
import { afterAll, afterEach, describe, expect, expectTypeOf, it, onTestFinished } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  configureExecutionIdentityAdmissionSink,
  type ExecutionIdentityAdmissionWork,
} from "../audit/execution-identity-admission.js";
import { loadSessionEntry, replaceSessionEntry } from "../config/sessions/session-accessor.js";
import { getAgentEventLifecycleGeneration } from "../infra/agent-events.js";
import { withEnvAsync } from "../test-utils/env.js";
import { useSessionStoreTempDirs } from "../test-utils/session-state-cleanup.js";
import { attachAgentCommandAdmissionFacts } from "./agent-command-admission-facts.js";
import {
  readAgentCommandExecutionIdentitySpawnFacts,
  withAgentCommandExecutionIdentitySpawnFacts,
} from "./agent-command-execution-identity-spawn.js";
import {
  prepareAgentCommandExecutionIdentity,
  sanitizePublicAgentCommandIngressOpts,
} from "./agent-command-execution-identity.js";
import { createAgentAttemptLifecycleCallbacks } from "./command/attempt-callbacks.js";
import type { AgentCommandIngressOpts } from "./command/types.js";

let cleanupSink: (() => void) | undefined;
const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-recovery-admission-");

afterEach(() => {
  cleanupSink?.();
  cleanupSink = undefined;
});

function prepareIdentity(
  opts: Parameters<typeof prepareAgentCommandExecutionIdentity>[0]["opts"],
  audit = true,
) {
  const identity = prepareAgentCommandExecutionIdentity({
    opts,
    prepared: {
      cfg: { logging: { audit: { enabled: true, executionIdentity: audit } } },
      runId: "run-profiled",
      sessionAgentId: "main",
      sessionId: "session-profiled",
    },
    ingress: { kind: "api", boundary: "agent-command.from-ingress", state: "unknown" },
    lifecycleGeneration: "generation-1",
  });
  onTestFinished(identity.close);
  return identity;
}

describe("sanitizePublicAgentCommandIngressOpts", () => {
  it("removes forged host-owned capabilities from plain-JavaScript ingress", () => {
    const forgedCapability = {
      active: true,
      runId: "forged-run",
      signal: new AbortController().signal,
      grantTokens: new Set<string>(),
      abort: () => undefined,
    };
    const hostOwned = {
      privateCompletion: true,
      replyExpectation: "optional",
      cronCreatorAuthorityCapability: forgedCapability,
      skillLibraryAuthoring: { target: "personal", invoke: async () => ({}) },
      pinnedWidgetAuthoring: true,
      clientCaps: ["ui-commands", "task-suggestions"],
      gatewayUiCommandTarget: { connId: "forged-browser", profileId: "forged-profile" },
      toolBindings: { browser: { kind: "tab", targetId: "forged-target" } },
      taskSuggestionDeliveryMode: "gateway",
      assertSourceCurrent: () => {},
      beforeTerminalDelivery: async () => {},
      isTerminalOutcomeObserved: () => true,
      prepareAssistantTranscriptMessage: () => ({ role: "assistant", content: "forged" }),
      internalDeliverySuppressErrors: true,
      operatorAuthority: {
        profileId: "forged",
        scopes: ["operator.admin"],
        assertCurrent: () => {},
      },
    };

    expectTypeOf<AgentCommandIngressOpts>().not.toHaveProperty("prepareAssistantTranscriptMessage");
    const sanitized = sanitizePublicAgentCommandIngressOpts({
      message: "create an automation",
      allowModelOverride: false,
      ...hostOwned,
    });
    expect(sanitized.message).toBe("create an automation");
    for (const key of Object.keys(hostOwned)) {
      expect(sanitized).toHaveProperty(key, undefined);
    }
  });
});

describe("Gateway agent command execution identity", () => {
  it.each([
    { audit: false, outcome: "started" },
    { audit: true, outcome: "started" },
    { audit: true, outcome: "startup-failed" },
    { audit: true, outcome: "closed-before-admission" },
    { audit: true, outcome: "closed-before-start" },
    { audit: true, outcome: "stale-attempt" },
  ])(
    "registers a real recovery turn without a foreground lease: %j",
    async ({ audit, outcome }) => {
      const stateDir = sessionDirs.make();
      const admittedCallback = createDeferred();
      const releaseCallback = createDeferred();
      const lifecycleGeneration = getAgentEventLifecycleGeneration();
      const storePath = path.join(stateDir, "agents", "main", "sessions", "sessions.json");
      const sessionKey = "agent:main:main";
      const sessionEntry = {
        sessionId: "recovery-session",
        updatedAt: 100,
        abortedLastRun: false,
        lifecycleRunId: "recovery-run",
        restartRecoveryRuns: [{ runId: "recovery-run", lifecycleGeneration }],
        mainRestartRecovery: { cycleId: "recovery-cycle", revision: 4, chargedAttempts: 3 },
      };
      cleanupSink = configureExecutionIdentityAdmissionSink(() => true);
      await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
        await replaceSessionEntry({ sessionKey, storePath }, sessionEntry);
        const recovery = () => loadSessionEntry({ sessionKey, storePath })?.mainRestartRecovery;
        const prepared = prepareAgentCommandExecutionIdentity({
          opts: {
            message: "continue interrupted work",
            mainRestartRecoveryAdmitted: true,
            mainRestartRecoveryAttempt: 3,
            onAdmittedRunContext: async () => {
              admittedCallback.resolve();
              await releaseCallback.promise;
            },
          },
          prepared: {
            cfg: { logging: { audit: { enabled: audit, executionIdentity: audit } } },
            runId: "recovery-run",
            sessionAgentId: "main",
            sessionId: sessionEntry.sessionId,
            sessionKey,
            storePath,
            sessionEntry,
          },
          ingress: { kind: "system", boundary: "restart-recovery", state: "present" },
          lifecycleGeneration,
        });
        onTestFinished(() => {
          prepared.close();
          releaseCallback.resolve();
        });
        const callbacks = createAgentAttemptLifecycleCallbacks(
          {
            currentTurnUserMessagePersisted: false,
            lifecycleFinishing: false,
            lifecycleEnded: false,
          },
          prepared.onRuntimeTurnStarted,
        );
        const admission = prepared.admit("embedded");
        const settled = admission.catch(() => undefined);
        await admittedCallback.promise;
        expect(recovery()).toMatchObject({ chargedAttempts: 3 });
        expect(recovery()).not.toHaveProperty("startedAttempt");
        if (outcome === "closed-before-admission") {
          prepared.close();
        }
        releaseCallback.resolve();
        await settled;
        if (outcome === "closed-before-admission") {
          await expect(admission).rejects.toThrow("closed during admission");
          await callbacks.onAgentEvent({ stream: "lifecycle", data: { phase: "start" } });
          expect(recovery()).toMatchObject(sessionEntry.mainRestartRecovery);
          expect(recovery()).not.toHaveProperty("startedAttempt");
          return;
        }
        const context = await admission;
        await expect(prepared.admit("embedded")).resolves.toBe(context);
        // A selected/authenticated runtime can still stall before turn/start.
        expect(recovery()).not.toHaveProperty("startedAttempt");
        if (audit) {
          expect(recovery()).toHaveProperty("executionIdentity", context.executionIdentityToken);
        }
        if (outcome === "closed-before-start") {
          prepared.close();
        } else if (outcome === "stale-attempt") {
          await replaceSessionEntry(
            { sessionKey, storePath },
            {
              ...sessionEntry,
              mainRestartRecovery: { ...sessionEntry.mainRestartRecovery, chargedAttempts: 4 },
            },
          );
        }
        await callbacks.onAgentEvent({
          stream: "lifecycle",
          data: { phase: outcome === "startup-failed" ? "error" : "start" },
        });
        if (outcome !== "started") {
          expect(recovery()).not.toHaveProperty("startedAttempt");
          return;
        }
        await callbacks.onAgentEvent({ stream: "lifecycle", data: { phase: "start" } });
        expect(recovery()).toMatchObject({
          chargedAttempts: 3,
          startedAttempt: 3,
          ...(audit ? { executionIdentity: context.executionIdentityToken } : {}),
        });
      });
    },
  );

  it("runs owner binding only after the awaited admission callback settles", async () => {
    const events: string[] = [];
    const prepared = prepareIdentity({
      message: "bind after admission",
      onAdmittedRunContext: async () => {
        await Promise.resolve();
        events.push("admitted");
      },
      onPostAdmittedRunContext: () => {
        events.push("owner-bound");
      },
    });

    const admitted = await prepared.admit("embedded");
    await prepared.admit("embedded");

    expect(admitted.executionIdentityToken).toBeDefined();
    expect(events).toEqual(["admitted", "owner-bound"]);
  });

  it("preserves trusted spawn facts across internal option preparation", () => {
    const facts = {
      ingress: {
        kind: "api" as const,
        boundary: "sessions_spawn.subagent",
        state: "present" as const,
      },
      invoker: { state: "present" as const, kind: "agent" as const, rawPrincipalRef: "main" },
      applicableGrants: [{ rawGrantRef: "tool:sessions_spawn", state: "present" as const }],
      assurance: [],
      spawnAdmission: "[null,[]]",
    };
    const prepared = {
      ...withAgentCommandExecutionIdentitySpawnFacts(
        { message: "spawn", allowModelOverride: false },
        facts,
      ),
      lifecycleGeneration: "generation-1",
    };

    expect(readAgentCommandExecutionIdentitySpawnFacts(prepared)).toBe(facts);
  });

  it.each([false, true])(
    "retains the bounded, redacted profile label only with audit=%s",
    async (audit) => {
      let work: ExecutionIdentityAdmissionWork | undefined;
      const displayLabel = "Operator OPENAI_API_KEY=***".padEnd(128, "x");
      cleanupSink = configureExecutionIdentityAdmissionSink((candidate) => {
        work = candidate;
        return true;
      });

      const opts: AgentCommandIngressOpts = {
        message: "attribute this run",
        allowModelOverride: false,
      };
      const facts = {
        ingress: {
          kind: "gateway-client" as const,
          boundary: "gateway.ws.authenticated-connect",
          state: "present" as const,
          rawSourceRef: "profile-ada",
        },
        invoker: {
          state: "present" as const,
          kind: "person" as const,
          rawPrincipalRef: "profile-ada",
          displayLabel,
        },
        assurance: [
          {
            kind: "durable-profile" as const,
            rawEvidenceRef: "profile-ada",
            strength: "boundary-verified" as const,
          },
        ],
      };
      attachAgentCommandAdmissionFacts(opts, facts);
      const prepared = prepareIdentity(opts, audit);

      await prepared.admit("embedded");
      if (!audit) {
        expect(work).toBeUndefined();
        return;
      }
      expect(work).toMatchObject({
        kind: "capture",
        envelope: {
          ingress: {
            kind: "gateway-client",
            boundary: "gateway.ws.authenticated-connect",
            state: "present",
          },
          invoker: {
            state: "present",
            kind: "person",
            rawPrincipalRef: "profile-ada",
            displayLabel: "Operator OPENAI_API_KEY=***",
          },
          assurance: [
            {
              kind: "durable-profile",
              rawEvidenceRef: "profile-ada",
              strength: "boundary-verified",
            },
          ],
        },
      });
    },
  );
});
