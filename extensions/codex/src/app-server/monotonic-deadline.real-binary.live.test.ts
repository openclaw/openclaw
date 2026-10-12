// Live proof: a wall-clock rewind between attempt admission and timer arming must
// not stretch the execution budget. This drives the FULL production attempt flow
// (prepareCodexAttemptConnection -> createCodexAttemptTurnState ->
// createAgentHarnessAttemptDeadlineController -> onTimeout ->
// interruptCodexTurnAndWaitBestEffort) against a REAL codex app-server process over a
// real stdio byte transport. The monotonic admission seed is captured by production
// code (prepareCodexAttemptConnection), not reconstructed by the test.
//
// Gate: OPENCLAW_LIVE_TEST=1 and OPENCLAW_LIVE_CODEX_MONOTONIC_DEADLINE=1, plus
// OPENCLAW_CODEX_APP_SERVER_BIN pointing at a real codex binary (>= 0.149.0).
// Skipped by default so CI never depends on a local codex installation.
import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams } from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "openclaw/plugin-sdk/hook-runtime";
import {
  createAgentHarnessHostCapabilitiesForTest,
  createMockPluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { withTempDir } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveCodexAppServerRuntimeOptions } from "./config.js";
import type { CodexModelListResponse } from "./protocol.js";
import { runCodexAppServerAttempt } from "./run-attempt.js";
import { createCodexTestBindingStore } from "./session-binding.test-helpers.js";
import { createIsolatedCodexAppServerClient } from "./shared-client.js";

const LIVE =
  process.env.OPENCLAW_LIVE_TEST === "1" &&
  process.env.OPENCLAW_LIVE_CODEX_MONOTONIC_DEADLINE === "1";
const describeLive = LIVE ? describe : describe.skip;

// A short execution budget. The real codex process keeps a turn in `inProgress`
// for well past this window even when model auth fails (it retries the websocket/HTTPS
// transport before emitting turn/completed), so the budget can expire first. The
// budget must also exceed model/list + thread/start latency (~6s on a cold binary)
// so the turn is accepted before the budget expires.
const EXECUTION_BUDGET_MS = 15_000;
// How far the wall clock jumps backward after admission. Pre-fix, this stretches
// the Date.now()-based remaining budget by ~this much; post-fix, the monotonic
// seed keeps the budget at EXECUTION_BUDGET_MS.
const WALL_CLOCK_REWIND_MS = 120_000;

afterEach(() => {
  resetGlobalHookRunner();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describeLive("Codex app-server monotonic execution deadline (real binary)", () => {
  it("expires the execution budget and cancels over the real stdio transport despite a wall-clock rewind", async () => {
    await withTempDir("openclaw-codex-monotonic-deadline-", async (root) => {
      const workspace = path.join(root, "workspace");
      const agentDir = path.join(root, "agent");
      const codexHome = path.join(root, "codex-home");
      await fs.mkdir(workspace, { recursive: true });
      await fs.mkdir(codexHome, { recursive: true });
      vi.stubEnv("OPENCLAW_STATE_DIR", path.join(root, "state"));

      // Mirror the user codex auth into an isolated CODEX_HOME so the proof never
      // touches the production codex home. The key need not be valid — a 403 from
      // the model provider still leaves the turn inProgress long enough for the
      // execution budget to expire first.
      try {
        const userAuth = readFileSync(
          path.join(process.env.HOME ?? "", ".codex", "auth.json"),
          "utf8",
        );
        await fs.writeFile(path.join(codexHome, "auth.json"), userAuth);
      } catch {
        // No user auth to mirror; the real binary surfaces auth errors but the
        // turn still transitions through inProgress before completing.
      }

      const runtime = resolveCodexAppServerRuntimeOptions({
        pluginConfig: { appServer: { homeScope: "agent" } },
        env: process.env,
      });
      const client = await createIsolatedCodexAppServerClient({
        startOptions: { ...runtime.start, env: { CODEX_HOME: codexHome } },
        agentDir,
        authProfileId: null,
        timeoutMs: 120_000,
      });
      let closeHost: (() => void) | undefined;
      try {
        const listed = await client.request<CodexModelListResponse>(
          "model/list",
          { limit: 100, cursor: null, includeHidden: false },
          { timeoutMs: 60_000 },
        );
        const modelId =
          listed.data.find((model) => model.isDefault)?.model ?? listed.data[0]?.model;
        if (!modelId) {
          throw new Error("Codex model/list returned no models");
        }

        initializeGlobalHookRunner(createMockPluginRegistry([]));

        // Spy every JSON-RPC request the real client sends through its byte
        // transport. turn/start marks admission; turn/interrupt proves the
        // cancellation crossed the real stdio transport.
        const requestSpy = vi.spyOn(client, "request");
        const turnCompletedStatuses: string[] = [];
        client.addNotificationHandler((notification) => {
          if (notification.method === "turn/completed") {
            const status = (notification.params as { turn?: { status?: string } })?.turn?.status;
            turnCompletedStatuses.push(status ?? "unknown");
          }
          return undefined;
        });

        let attemptTimedOut = false;
        const params = {
          sessionId: "monotonic-deadline-session",
          sessionKey: "agent:monotonic-deadline:main",
          sessionFile: path.join(root, "session.jsonl"),
          workspaceDir: workspace,
          cwd: workspace,
          agentDir,
          provider: "codex",
          modelId,
          model: {
            id: modelId,
            name: modelId,
            provider: "codex",
            api: "openai-chatgpt-responses",
            reasoning: true,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 200_000,
            maxTokens: 8_000,
            compat: { supportsTools: false },
          },
          prompt: "Reply with the single word hello.",
          runId: "monotonic-deadline-run",
          contextTokenBudget: 150_000,
          contextWindowInfo: {
            tokens: 150_000,
            referenceTokens: 200_000,
            source: "agentContextTokens",
          },
          thinkLevel: "medium",
          disableTools: true,
          config: undefined,
          timeoutMs: EXECUTION_BUDGET_MS,
          trigger: "user",
          oneShotCliRun: true,
          senderIsOwner: true,
          authStorage: {},
          authProfileStore: { version: 1, profiles: {} },
          modelRegistry: {},
          onAttemptTimeout: () => {
            attemptTimedOut = true;
          },
        } as unknown as EmbeddedRunAttemptParams;
        const host = await createAgentHarnessHostCapabilitiesForTest({
          attempt: params,
          pluginId: "codex",
          nativeModelPolicySupport: "exact",
        });
        params.hostCapabilities = host.capabilities;
        closeHost = host.close;

        const bindingStore = createCodexTestBindingStore();

        // Simulate an NTP correction that jumps the wall clock backward AFTER the
        // admission seed is captured but BEFORE/AROUND timer arming. We spy only
        // Date.now — setTimeout, performance.now, and the event loop keep running,
        // so the real stdio transport and the real codex process are unaffected.
        // Pre-fix (Date.now()-based budget), this rewind stretches the remaining
        // budget by ~WALL_CLOCK_REWIND_MS so the 5s budget never expires; post-fix
        // (performance.now()-based), the budget still expires at 5s.
        const realDateNow = Date.now;
        let admitted = false;
        vi.spyOn(Date, "now").mockImplementation(() => {
          return admitted ? realDateNow.call(Date) - WALL_CLOCK_REWIND_MS : realDateNow.call(Date);
        });
        const innerOnAttemptDeadlineChanged = params.onAttemptDeadlineChanged;
        params.onAttemptDeadlineChanged = (deadline: unknown) => {
          // The first bounded deadline marks that the admission seed has been
          // captured and the execution timer is arming — start the rewind now.
          if (!admitted && (deadline as { kind?: string })?.kind === "bounded") {
            admitted = true;
          }
          if (typeof innerOnAttemptDeadlineChanged === "function") {
            innerOnAttemptDeadlineChanged(deadline as never);
          }
        };

        await runCodexAppServerAttempt(params, {
          bindingStore,
          pluginConfig: { appServer: { homeScope: "agent" } },
          clientFactory: async () => client,
        });

        // The execution budget must have expired despite the wall-clock rewind.
        expect(attemptTimedOut, "execution budget did not expire under wall-clock rewind").toBe(
          true,
        );

        // turn/interrupt must have crossed the real stdio byte transport.
        const interruptCall = requestSpy.mock.calls.find(([method]) => method === "turn/interrupt");
        expect(
          interruptCall,
          "turn/interrupt was not sent over the real stdio transport",
        ).toBeDefined();

        // The real codex process must have acknowledged the cancellation with a
        // turn/completed notification carrying status=interrupted.
        expect(turnCompletedStatuses).toContain("interrupted");

        // The real binary must have admitted a thread and a turn before the budget
        // expired (turn/start and turn/interrupt both crossed the real transport).
        const turnStartCall = requestSpy.mock.calls.find(([method]) => method === "turn/start");
        expect(
          turnStartCall,
          "turn/start was not sent over the real stdio transport",
        ).toBeDefined();
      } finally {
        closeHost?.();
        await client.closeAndWait();
      }
    });
  }, 180_000);
});
