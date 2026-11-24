import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { MEMORY_DREAMING_SYSTEM_EVENT_TEXT } from "openclaw/plugin-sdk/memory-core-host-status";
import {
  createPluginRecord,
  createPluginRegistry,
  createPluginRuntimeMock,
  disposePluginRegistryInstances,
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, expect, it, vi } from "vitest";
import { runCliBeforeAgentReply } from "../../../src/agents/cli-runner/before-agent-reply.js";
import { setRuntimeConfigSnapshot } from "../../../src/config/runtime-snapshot.js";
import * as isolated from "../../../src/cron/isolated-agent/run.test-harness.js";
import {
  cronTestDeps,
  cronTestInput,
} from "../../../src/cron/service.fixture-builders.test-support.js";
import { CronService } from "../../../src/cron/service.js";
import type { CronServiceDeps } from "../../../src/cron/service/state.js";
import { loadCronStore } from "../../../src/cron/store.js";
import { withOpenClawTestState } from "../../../src/test-utils/openclaw-test-state.js";
import { runDreamNarrative } from "./dreaming-narrative.js";
import { runDreamingSweepPhases } from "./dreaming-phases.js";
import { registerShortTermPromotionDreaming } from "./dreaming.js";
import { configureMemoryCoreDreamingStateForTests } from "./test-helpers.js";

vi.mock("./dreaming-phases.js", { spy: true });
vi.mock("./dreaming-narrative.js", { spy: true });

const runCronIsolatedAgentTurn = await isolated.loadRunCronIsolatedAgentTurn();
const firstError = "SQLite session reclamation commit checkpoint expired";

afterEach(() => {
  resetGlobalHookRunner();
  vi.restoreAllMocks();
});

it.each([
  { failed: 1, degraded: false, mode: "announce" },
  { failed: 3, degraded: false, mode: "webhook" },
  { failed: 0, degraded: false, mode: "announce" },
  { failed: 0, degraded: true, mode: "announce" },
] as const)(
  "records scheduled sweep health (failed=$failed, degraded=$degraded)",
  async ({ failed, degraded, mode }) => {
    isolated.resetRunCronIsolatedAgentTurnHarness();
    const { resolveCronPayloadOutcome } = await vi.importActual<
      typeof import("../../../src/cron/isolated-agent/helpers.js")
    >("../../../src/cron/isolated-agent/helpers.js");
    isolated.resolveCronPayloadOutcomeMock.mockImplementation(resolveCronPayloadOutcome);
    const modelRef = { provider: "openai", model: "gpt-5.4" };
    isolated.resolveConfiguredModelRefMock.mockReturnValue(modelRef);
    isolated.mockRunCronFallbackPassthrough();
    // Exercise the real synthetic runner, not a fabricated cron status or reply payload.
    isolated.runEmbeddedAgentMock.mockImplementation(async (params) => {
      const result = await runCliBeforeAgentReply(params);
      if (!result) {
        throw new Error("The managed Dreaming hook must claim the scheduled turn");
      }
      return result;
    });

    await withOpenClawTestState(
      { layout: "state-only", prefix: "dreaming-cron-outcome-" },
      async (state) => {
        const workspaces = ["main", "research", "notes"].map((name) => state.path(name));
        const cfg: OpenClawConfig = {
          session: { store: "/tmp/store.json" },
          agents: {
            defaults: { workspace: workspaces[0], model: "openai/gpt-5.4" },
            entries: Object.fromEntries(
              workspaces.map((workspace, i) => [i === 0 ? "main" : `agent-${i}`, { workspace }]),
            ),
          },
          plugins: { entries: { "memory-core": { config: { dreaming: { enabled: true } } } } },
        };
        setRuntimeConfigSnapshot(cfg);
        const visited: string[] = [];
        vi.mocked(runDreamingSweepPhases).mockImplementation(async ({ workspaceDir }) => {
          visited.push(workspaceDir);
          if (workspaces.slice(0, failed).includes(workspaceDir)) {
            throw new Error(
              workspaceDir === workspaces[0] ? firstError : "later workspace failure",
            );
          }
          return {
            failed: false,
            narratives:
              workspaceDir === workspaces[2]
                ? [{ data: { phase: "light", snippets: ["A synthetic memory trace."] } }]
                : [],
          };
        });
        // Diary lifecycle is covered by dreaming-sweep-narrative.test.ts. This fixture
        // supplies only its synchronous outcome; pending is not a failure signal.
        vi.mocked(runDreamNarrative).mockResolvedValue({
          status: degraded ? "degraded" : "pending",
        });
        const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
        const builder = createPluginRegistry({
          logger,
          runtime: createPluginRuntimeMock({ config: { current: () => cfg } }),
          activateGlobalSideEffects: false,
        });
        const record = createPluginRecord({ id: "memory-core", origin: "bundled", kind: "memory" });
        builder.registry.plugins.push(record);
        const api = builder.createApi(record, { config: cfg });
        await api.lifecycle.runInBackgroundContext!(() =>
          configureMemoryCoreDreamingStateForTests(),
        );
        registerShortTermPromotionDreaming(api);
        initializeGlobalHookRunner(builder.registry);
        isolated.preparedRunPluginRegistryMock.mockReturnValue(builder.registry);
        isolated.ensureAgentWorkspaceMock.mockResolvedValue({ dir: workspaces[0] });
        const sendCronFailureAlert = vi.fn<NonNullable<CronServiceDeps["sendCronFailureAlert"]>>(
          async () => undefined,
        );
        const storePath = state.path("cron", "jobs.json");
        const cron = new CronService({
          ...cronTestDeps({ storePath }),
          cronConfig: {
            failureAlert: {
              enabled: true,
              after: 1,
              cooldownMs: 0,
              mode,
              ...(mode === "webhook" ? { to: "https://example.com/dreaming-alert" } : {}),
            },
          },
          sendCronFailureAlert,
          runIsolatedAgentJob: (params) =>
            runCronIsolatedAgentTurn({
              ...params,
              cfg,
              deps: {},
              sessionKey: `cron:${params.job.id}`,
            }),
        });
        try {
          await cron.start();
          const job = await cron.add(
            cronTestInput({
              name: "Memory Dreaming Promotion",
              agentId: "main",
              delivery: { mode: "none" },
              payload: { kind: "agentTurn", message: MEMORY_DREAMING_SYSTEM_EVENT_TEXT },
            }),
          );
          await expect(cron.run(job.id, "force")).resolves.toEqual({ ok: true, ran: true });
          const saved = (await loadCronStore(storePath)).jobs.find(({ id }) => id === job.id);
          const unhealthy = failed > 0 || degraded;
          expect(visited.toSorted(), saved?.state.lastError).toEqual(workspaces.toSorted());
          expect(saved?.state).toMatchObject({
            lastRunStatus: unhealthy ? "error" : "ok",
            consecutiveErrors: unhealthy ? 1 : 0,
          });
          expect(sendCronFailureAlert).toHaveBeenCalledTimes(unhealthy ? 1 : 0);
          if (failed) {
            expect(saved?.state.lastError).toContain(`${failed} of 3 workspaces failed`);
            expect(saved?.state.lastError).toContain(firstError);
            expect(saved?.state.lastErrorReason).toBe("unknown");
            const alert = sendCronFailureAlert.mock.calls[0]?.[0].payload.text;
            expect(alert).not.toContain("Cause: auth");
            if (mode === "webhook") {
              expect(alert).toContain(firstError);
              expect(alert).toContain(`${failed} of 3 workspaces failed`);
            }
            expect(logger.warn.mock.calls.flat().join("\n")).toContain(`failed=${failed}`);
          } else if (!degraded) {
            expect(saved?.state.lastFailureNotificationDeliveryStatus).toBe("not-requested");
            expect(logger.error).not.toHaveBeenCalled();
            expect(logger.info.mock.calls.flat().join("\n")).toContain("narrativesPending=1");
          }
        } finally {
          cron.stop();
          await disposePluginRegistryInstances(builder.registry);
        }
      },
    );
  },
);
