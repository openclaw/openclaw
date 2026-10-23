import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import {
  loadTranscriptEvents,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import { useTempSessionsFixture } from "../../config/sessions/test-helpers.js";
import { bindOwnedSessionTranscriptWrites } from "../../config/sessions/transcript-write-context.js";
import * as transcript from "../../config/sessions/transcript.js";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
import { getAgentRunContext } from "../../infra/agent-run-registry.js";
import { bindAgentRunTerminalWriteContext } from "../../infra/agent-run-terminal-writes.js";
import { readModelFallbackNotice } from "../../shared/model-fallback-notice.js";
import { prepareSystemAgentRunAdmission } from "../admitted-run-context.js";
import { FailoverError } from "../failover-error.js";
import type { ModelFallbackStepFields } from "../model-fallback-observation.js";
import { runEmbeddedAgentEntry } from "./run-entry.js";
import { createDirectHarness, makeResult } from "./run-entry.test-support.js";

// Provider I/O and plugin preparation are fixtures; fallback decisions and durable writes are real.
// mock-isolation: Candidate outcomes are explicit; exclude ambient credential-store discovery.
vi.mock("../auth-profiles/source-check.js", () => ({
  hasAnyAuthProfileStoreSourceAsync: () => false,
}));
// mock-isolation: The direct harness fixture must not load or activate the global plugin registry.
vi.mock("../harness/runtime-plugin.js", () => ({
  ensureSelectedAgentHarnessPlugin: async () => undefined,
}));
// mock-isolation: Fix direct-harness metadata while the real fallback loop and write owners run.
vi.mock("../harness/selection.js", () => ({
  selectAgentHarness: () => ({ id: "openclaw", contextEngineHostCapabilities: [] }),
}));

describe("run entry durable fallback notices", () => {
  const files = useTempSessionsFixture("fallback-transcript-");
  afterEach(() => {
    clearRuntimeConfigSnapshot();
    vi.restoreAllMocks();
  });

  async function fixture(
    options: {
      onStep?: (step: ModelFallbackStepFields) => void | Promise<void>;
      missingSession?: boolean;
      maintenance?: boolean;
      omitSessionKey?: boolean;
      abortSignal?: AbortSignal;
      writerContext?: boolean;
    } = {},
  ) {
    const identity = {
      agentId: "main",
      sessionKey: "agent:main:fallback-notice",
      sessionId: "fallback-notice-session",
      runId: "fallback-notice-run",
    };
    const scope = { ...identity, storePath: files.storePath() };
    const entry: InternalSessionEntry = {
      sessionId: identity.sessionId,
      lifecycleRevision: "original-revision",
      activeWriterRunId: identity.runId,
      updatedAt: 1,
    };
    if (!options.missingSession) {
      await replaceSessionEntry(scope, entry);
    }
    const cfg = { session: { store: files.storePath() } };
    setRuntimeConfigSnapshot(cfg);
    const admission = prepareSystemAgentRunAdmission(
      cfg,
      identity.runId,
      identity.agentId,
      "fallback-notice-test",
    );
    const candidates: string[] = [];
    const steps: ModelFallbackStepFields[] = [];
    const run = () =>
      runEmbeddedAgentEntry({
        selection: {
          cfg,
          provider: "openai",
          model: "gpt-4.1-mini",
          fallbacksOverride: ["anthropic/claude-haiku-3-5"],
        },
        identity: {
          ...identity,
          sessionLifecycleRevision: entry.lifecycleRevision ?? null,
          ...(options.omitSessionKey ? { sessionKey: undefined } : {}),
        },
        preparedRunAdmission: admission,
        harness: {
          ...createDirectHarness(),
          workspaceDir: files.sessionsDir(),
          sessionKey: "agent:main:policy-only",
        },
        behavior: options.maintenance
          ? { kind: "maintenance" as const }
          : { kind: "command-rpc" as const, hasCommittedSideEffect: () => false },
        sessionOverride: { kind: "preserve" },
        abortSignal: options.abortSignal,
        onFallbackStep: async (step) => {
          steps.push(step);
          await options.onStep?.(step);
        },
        runCandidate: async (provider, model) => {
          await admission.admit("embedded");
          if (options.writerContext) {
            const authority = getAgentRunContext(identity.runId)?.delegatedAuthority;
            if (!authority) {
              throw new Error("Missing fixture run authority");
            }
            bindAgentRunTerminalWriteContext(authority, {
              run: (write) =>
                bindOwnedSessionTranscriptWrites(
                  {
                    sessionTarget: {
                      ...scope,
                      expectedWriterRunId: identity.runId,
                      expectedLifecycleRevision: entry.lifecycleRevision,
                    },
                    withTranscriptWrite: async (work) => work(),
                  },
                  write,
                )(),
            });
          }
          candidates.push(`${provider}/${model}`);
          if (provider === "openai") {
            throw new FailoverError("private provider error: synthetic-secret", {
              provider,
              model,
              reason: "rate_limit",
            });
          }
          return makeResult({ provider, model });
        },
      });
    return { scope, entry, candidates, steps, run, [Symbol.dispose]: () => admission.close() };
  }

  it("persists a real transition once, preserving callbacks and source-session binding", async () => {
    using f = await fixture();
    expect((await f.run()).provider).toBe("anthropic");
    expect((await f.run()).provider).toBe("anthropic");
    expect(f.steps.map((step) => step.fallbackStepFinalOutcome)).toEqual([
      "next_fallback",
      "succeeded",
      "next_fallback",
      "succeeded",
    ]);
    const events = await loadTranscriptEvents(f.scope);
    const notices = events
      .map((event) => readModelFallbackNotice(asOptionalRecord(event)?.message))
      .filter(Boolean);
    expect(notices).toEqual([
      {
        kind: "model-fallback",
        runId: f.scope.runId,
        fromModel: "openai/gpt-4.1-mini",
        toModel: "anthropic/claude-haiku-3-5",
        reason: "rate_limit",
      },
    ]);
    expect(JSON.stringify(events)).not.toContain("synthetic-secret");
    expect(JSON.stringify(events)).not.toContain("policy-only");
    expect(events.filter((event) => asOptionalRecord(event)?.type === "message")).toHaveLength(1);
  });

  it("keeps the fallback usable when notice storage and an observer fail", async () => {
    using f = await fixture({
      onStep: () => {
        throw new Error("observer failed");
      },
    });
    const append = vi
      .spyOn(transcript, "appendAssistantMessageToSessionTranscript")
      .mockRejectedValue(new Error("synthetic storage failure"));
    expect((await f.run()).provider).toBe("anthropic");
    expect(append).toHaveBeenCalledTimes(1);
    expect(f.candidates).toEqual(["openai/gpt-4.1-mini", "anthropic/claude-haiku-3-5"]);
  });

  const replacements = [
    { sessionId: "replacement-session" },
    { activeWriterRunId: "replacement-run" },
    { lifecycleRevision: "replacement-revision" },
  ];
  it.each(
    [false, true].flatMap((writerContext) =>
      replacements.map((replacement) => ({ writerContext, replacement })),
    ),
  )(
    "refuses a notice after $replacement with bound writer=$writerContext",
    async ({ writerContext, replacement }) => {
      using f = await fixture({
        writerContext,
        onStep: async (step) => {
          if (step.fallbackStepFinalOutcome === "next_fallback") {
            await replaceSessionEntry(f.scope, { ...f.entry, ...replacement });
          }
        },
      });
      await f.run();
      expect(await loadTranscriptEvents(f.scope)).toEqual([]);
      expect(await loadTranscriptEvents({ ...f.scope, sessionId: "replacement-session" })).toEqual(
        [],
      );
    },
  );

  it.each(["observer", "commit"] as const)(
    "rechecks cancellation at the %s boundary",
    async (boundary) => {
      const controller = new AbortController();
      const message =
        boundary === "observer" ? "cancelled fallback" : "cancelled before notice commit";
      const abort = () => controller.abort(new Error(message));
      using f = await fixture({
        abortSignal: controller.signal,
        onStep: (step) => {
          if (boundary === "observer" && step.fallbackStepFinalOutcome === "next_fallback") {
            abort();
          }
        },
      });
      if (boundary === "commit") {
        const append = transcript.appendAssistantMessageToSessionTranscript;
        vi.spyOn(transcript, "appendAssistantMessageToSessionTranscript").mockImplementationOnce(
          async (params) => {
            abort();
            return append(params);
          },
        );
      }
      await expect(f.run()).rejects.toThrow(message);
      expect(await loadTranscriptEvents(f.scope)).toEqual([]);
      expect(f.candidates).toEqual(["openai/gpt-4.1-mini"]);
    },
  );

  it.each(["maintenance", "missingSession", "omitSessionKey"] as const)(
    "skips durable notices for %s contexts",
    async (skip) => {
      using f = await fixture({ [skip]: true });
      expect((await f.run()).provider).toBe("anthropic");
      expect(await loadTranscriptEvents(f.scope)).toEqual([]);
    },
  );
});
