import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { RequestScopedSubagentRuntimeError } from "openclaw/plugin-sdk/error-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { listMemoryArtifactProvenance } from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import { MEMORY_DREAMING_SYSTEM_EVENT_TEXT } from "openclaw/plugin-sdk/memory-core-host-status";
import type { OpenClawPluginServiceContext } from "openclaw/plugin-sdk/plugin-entry";
import {
  createTestPluginApi,
  createTestPluginServiceScheduler,
} from "openclaw/plugin-sdk/plugin-test-api";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import { clearRuntimeConfigSnapshot } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { enqueueSystemEvent } from "openclaw/plugin-sdk/system-event-runtime";
import { resetSystemEventsForTest } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";
import { appendNarrativeEntry } from "./dreaming-dreams-file.js";
import type { DreamingCompletion } from "./dreaming-narrative.js";
import { registerShortTermPromotionDreaming } from "./dreaming.js";
import { recordMemoryEntryOrigins } from "./memory-entry-origins.js";
import { forgetMemoryEntries } from "./memory-forget.js";
import {
  configureMemoryCoreDreamingStateForTests,
  createMemoryCoreTestHarness,
  shortTermTestState,
} from "./test-helpers.js";

vi.mock("openclaw/plugin-sdk/memory-core-host-runtime-core", { spy: true });

const { createTempWorkspace } = createMemoryCoreTestHarness();
const NOW_MS = Date.parse("2026-04-05T10:00:00.000Z");
const DAY = "2026-04-05";
const FRAGMENT = "Move archive backups to encrypted cold storage.";
type CompletionInput = Parameters<DreamingCompletion["complete"]>[0];
type BeforeReply = (
  event: { cleanedBody: string },
  context: { trigger: string; agentId: string; workspaceDir: string; sessionKey: string },
) => Promise<unknown>;

afterEach(() => {
  resetSystemEventsForTest();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  clearRuntimeConfigSnapshot();
});

async function createSweep(
  options: {
    promote?: boolean;
    empty?: boolean;
    narrativeError?: Error;
    failDeepReport?: boolean;
    failRemReport?: boolean;
    narrativeGate?: Promise<void>;
  } = {},
) {
  const workspaceDir = await createTempWorkspace("sweep-narrative-");
  vi.stubEnv("OPENCLAW_STATE_DIR", path.join(workspaceDir, ".state"));
  clearRuntimeConfigSnapshot();
  await configureMemoryCoreDreamingStateForTests();
  vi.spyOn(Date, "now").mockReturnValue(NOW_MS);
  vi.mocked(listMemoryArtifactProvenance).mockResolvedValue([]);
  await fs.mkdir(path.join(workspaceDir, "memory"), { recursive: true });
  if (!options.empty) {
    await fs.writeFile(
      path.join(workspaceDir, "memory", `${DAY}.md`),
      `# ${DAY}\n\n- ${FRAGMENT}\n`,
    );
  }
  if (options.failDeepReport || options.failRemReport) {
    await fs.mkdir(path.join(workspaceDir, "memory", "dreaming"), { recursive: true });
    // Fail a real report writer after its preceding phase has prepared inputs.
    const phase = options.failRemReport ? "rem" : "deep";
    await fs.writeFile(path.join(workspaceDir, "memory", "dreaming", phase), "not a directory");
  }
  const config: OpenClawConfig = {
    agents: {
      defaults: { workspace: workspaceDir, timeoutSeconds: 180 },
      entries: { main: { workspace: workspaceDir } },
    },
    plugins: {
      entries: {
        "memory-core": {
          config: {
            dreaming: {
              enabled: true,
              timezone: "UTC",
              storage: { mode: "separate", separateReports: true },
              phases: {
                light: {
                  enabled: true,
                  limit: 10,
                  lookbackDays: 2,
                  execution: { model: "anthropic/claude-haiku-4-5" },
                },
                rem: {
                  enabled: true,
                  limit: 10,
                  lookbackDays: 2,
                  minPatternStrength: 0,
                  execution: { model: "xai/grok-4.1-fast" },
                },
                deep: {
                  limit: 10,
                  execution: { model: "openai/gpt-5.4" },
                  minScore: options.promote ? 0 : 1,
                  minRecallCount: options.promote ? 0 : 100,
                  minUniqueQueries: 0,
                },
              },
            },
          },
        },
      },
    },
  };
  const narratives: CompletionInput[] = [];
  const complete = vi.fn(async (input: CompletionInput) => {
    if (!input.extraSystemPrompt?.includes("You are keeping a dream diary")) {
      // Deliberately use the real append-only promotion fallback, not a fabricated plan.
      return { text: "" };
    }
    narratives.push(input);
    await options.narrativeGate;
    if (options.narrativeError) {
      throw options.narrativeError;
    }
    // Different replies make duplicate publications observable even without exact-text dedupe.
    return { text: `The archive glowed softly, entry ${narratives.length}.` };
  });
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const unexpectedSessionCall = vi.fn(async () => {
    throw new Error("Unexpected session-based subagent call");
  });
  const on = vi.fn();
  const registerService =
    vi.fn<Parameters<typeof registerShortTermPromotionDreaming>[0]["registerService"]>();
  const baseApi = createTestPluginApi({ config, logger, pluginConfig: {} });
  const agent = createPluginRuntimeMock().agent;
  const resolveTimeout = vi.mocked(agent.resolveAgentTimeoutMs).mockReturnValue(180_000);
  registerShortTermPromotionDreaming({
    ...baseApi,
    config,
    pluginConfig: {},
    runtime: {
      ...baseApi.runtime,
      agent,
      subagent: {
        complete,
        run: unexpectedSessionCall,
        waitForRun: unexpectedSessionCall,
        getSessionMessages: unexpectedSessionCall,
        deleteSession: unexpectedSessionCall,
      },
    },
    logger,
    on,
    registerService,
  });
  const registration = on.mock.calls.find(([name]) => name === "before_agent_reply");
  if (!registration) {
    throw new Error("dreaming trigger hook was not registered");
  }
  const beforeReply = registration[1] as BeforeReply;
  const run = async (trigger: "heartbeat" | "cron" = "heartbeat") => {
    const sessionKey = "agent:main:main";
    enqueueSystemEvent(MEMORY_DREAMING_SYSTEM_EVENT_TEXT, {
      agentId: "main",
      sessionKey,
      contextKey: "cron:memory-dreaming",
    });
    return await beforeReply(
      { cleanedBody: MEMORY_DREAMING_SYSTEM_EVENT_TEXT },
      { trigger, agentId: "main", workspaceDir, sessionKey },
    );
  };
  const readDreams = () =>
    fs.readFile(path.join(workspaceDir, "DREAMS.md"), "utf8").catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return "";
      }
      throw error;
    });
  const service = registerService.mock.calls.find(
    ([entry]) => entry.id === "memory-core-dreaming",
  )?.[0];
  if (!service?.stop) {
    throw new Error("dreaming service lifecycle was not registered");
  }
  const serviceContext = {
    config,
    workspaceDir,
    stateDir: path.join(workspaceDir, ".state"),
    logger,
    scheduler: createTestPluginServiceScheduler(),
  } satisfies OpenClawPluginServiceContext;
  return {
    workspaceDir,
    config,
    narratives,
    resolveTimeout,
    logger,
    run,
    readDreams,
    service,
    serviceContext,
  };
}

function diaryEntryCount(dreams: string): number {
  const diary =
    dreams
      .split("<!-- openclaw:dreaming:diary:start -->")[1]
      ?.split("<!-- openclaw:dreaming:diary:end -->")[0] ?? "";
  return diary.match(/\n---\n/g)?.length ?? 0;
}

describe("dreaming sweep diary publication", () => {
  it.each([false, true])(
    "publishes one entry for Light/REM with deep promotion=%s",
    async (promote) => {
      const sweep = await createSweep({ promote });
      const previousEntry = "The cobalt archive opened quietly yesterday.";
      if (!promote) {
        await appendNarrativeEntry({
          workspaceDir: sweep.workspaceDir,
          narrative: previousEntry,
          nowMs: NOW_MS - 60_000,
          timezone: "UTC",
        });
      }
      expect(await sweep.run()).toEqual({
        handled: true,
        reason: "memory-core: short-term dreaming processed",
      });
      expect(sweep.narratives).toHaveLength(1);
      expect(sweep.narratives[0]).toMatchObject({ agentId: "main", timeoutMs: 180_000 });
      expect(sweep.resolveTimeout).toHaveBeenCalledWith({ cfg: sweep.config });
      expect(sweep.narratives[0]?.message).toContain(FRAGMENT);
      expect(sweep.narratives[0]?.message).toContain(`Current sweep: ${DAY}`);
      expect(sweep.narratives[0]?.model).toBe(promote ? "openai/gpt-5.4" : "xai/grok-4.1-fast");
      if (!promote) {
        expect(sweep.narratives[0]?.message).toContain(previousEntry);
      }
      const dreams = await sweep.readDreams();
      expect(diaryEntryCount(dreams)).toBe(promote ? 1 : 2);
      expect(dreams).toContain("The archive glowed softly, entry 1.");
      const light = await fs.readFile(
        path.join(sweep.workspaceDir, "memory", "dreaming", "light", `${DAY}.md`),
        "utf8",
      );
      expect(light).toContain(FRAGMENT);
      const rem = await fs.readFile(
        path.join(sweep.workspaceDir, "memory", "dreaming", "rem", `${DAY}.md`),
        "utf8",
      );
      expect(rem).toContain("Theme:");
      const signals = await shortTermTestState.readPhaseSignalStore(
        sweep.workspaceDir,
        new Date(NOW_MS).toISOString(),
      );
      expect(Object.values(signals.entries)).toEqual([
        expect.objectContaining({
          lightHits: 1,
          lastRemConsideredAt: new Date(NOW_MS).toISOString(),
        }),
      ]);
      if (promote) {
        expect(sweep.narratives[0]?.message).toContain(
          "Memories that crystallized into something lasting",
        );
        expect(await fs.readFile(path.join(sweep.workspaceDir, "MEMORY.md"), "utf8")).toContain(
          FRAGMENT,
        );
        expect(
          await fs.readFile(
            path.join(sweep.workspaceDir, "memory", "dreaming", "deep", `${DAY}.md`),
            "utf8",
          ),
        ).toContain("Promoted 1 candidate(s)");
      } else {
        expect(sweep.narratives[0]?.message).not.toContain(
          "Memories that crystallized into something lasting",
        );
      }
    },
  );

  it.each([
    { label: "completion fails", error: new Error("synthetic completion failure") },
    { label: "completion is request-scoped", error: new RequestScopedSubagentRuntimeError() },
  ])("writes one generic fallback when $label", async ({ error }) => {
    const sweep = await createSweep({ narrativeError: error });
    expect(await sweep.run()).toEqual({
      handled: true,
      reason: "memory-core: short-term dreaming degraded",
    });
    expect(sweep.narratives).toHaveLength(1);
    const dreams = await sweep.readDreams();
    expect(diaryEntryCount(dreams)).toBe(1);
    expect(dreams).toContain("A memory trace surfaced, but details were unavailable in this run.");
    expect(dreams).not.toContain(FRAGMENT);
    expect(sweep.logger.warn.mock.calls.flat().join("\n")).toContain(
      "failed=0, degraded=1, narrativesPending=0",
    );
  });

  it("still publishes the prepared Light/REM entry when the deep report fails", async () => {
    const sweep = await createSweep({ promote: true, failDeepReport: true });
    await sweep.run();
    expect(sweep.logger.error.mock.calls.flat().join("\n")).toContain("dreaming promotion failed");
    expect(sweep.logger.warn.mock.calls.flat().join("\n")).toContain(
      "failed=1, degraded=0, narrativesPending=0",
    );
    expect(sweep.narratives).toHaveLength(1);
    expect(sweep.narratives[0]?.message).toContain(FRAGMENT);
    expect(sweep.narratives[0]?.message).toContain(
      "Memories that crystallized into something lasting",
    );
    expect(diaryEntryCount(await sweep.readDreams())).toBe(1);
  });

  it("publishes prepared Light material when REM report publication fails", async () => {
    const sweep = await createSweep({ failRemReport: true });
    await sweep.run();
    expect(sweep.logger.error.mock.calls.flat().join("\n")).toContain("rem dreaming failed");
    expect(sweep.logger.warn.mock.calls.flat().join("\n")).toContain(
      "failed=1, degraded=0, narrativesPending=0",
    );
    expect(sweep.narratives).toHaveLength(1);
    expect(sweep.narratives[0]?.message).toContain(FRAGMENT);
    expect(sweep.narratives[0]?.model).toBe("anthropic/claude-haiku-4-5");
    expect(diaryEntryCount(await sweep.readDreams())).toBe(1);
  });

  it.each([false, true])("settles the detached diary with Forget=%s", async (forget) => {
    const publish = createDeferred<void>();
    const sweep = await createSweep({ narrativeGate: publish.promise });
    // Cron management is optional; starting without it admits no timers or fake scheduler work.
    await sweep.service.start(sweep.serviceContext);
    let stopped = false;
    let stopping: Promise<void> | undefined;
    try {
      expect(await sweep.run("cron")).toEqual({
        handled: true,
        reason: "memory-core: short-term dreaming processed",
      });
      expect(sweep.narratives).toHaveLength(1);
      expect(sweep.narratives[0]?.message).toContain(FRAGMENT);
      stopping = Promise.resolve(sweep.service.stop?.(sweep.serviceContext)).then(() => {
        stopped = true;
      });
      if (forget) {
        const store = await shortTermTestState.readRecallStore(
          sweep.workspaceDir,
          new Date(NOW_MS).toISOString(),
        );
        const entries = Object.values(store.entries).filter((entry) => entry.snippet === FRAGMENT);
        expect(entries).toHaveLength(1);
        const entryKeys = entries.map((entry) => entry.key);
        const sessionId = "pending-diary-source";
        await recordMemoryEntryOrigins({
          agentId: "main",
          origins: entryKeys.map((entryKey) => ({
            entryKey,
            agentId: "main",
            sessionId,
            sessionKey: "agent:main:main",
            originClass: "owner",
            observedAt: NOW_MS,
          })),
        });
        const forgotten = await forgetMemoryEntries({
          cfg: sweep.config,
          agentId: "main",
          sessionIds: [sessionId],
        });
        expect(forgotten).toMatchObject({
          entryKeys,
          artifacts: { shortTermEntries: 1 },
          refusals: [],
        });
      }
      const dreams = await sweep.readDreams();
      expect(diaryEntryCount(dreams)).toBe(0);
      expect(stopped).toBe(false);
    } finally {
      publish.resolve();
      await (stopping ?? sweep.service.stop?.(sweep.serviceContext));
    }
    expect(stopped).toBe(true);
    const dreams = await sweep.readDreams();
    expect(diaryEntryCount(dreams)).toBe(forget ? 0 : 1);
    if (forget) {
      expect(dreams).not.toContain("The archive glowed softly, entry 1.");
      expect(sweep.logger.info.mock.calls.flat().join("\n")).toContain(
        "narrative publication skipped",
      );
    } else {
      expect(dreams).toContain("The archive glowed softly, entry 1.");
    }
    expect(sweep.narratives).toHaveLength(1);
  });

  it("does not invent a diary entry for an empty sweep", async () => {
    const sweep = await createSweep({ empty: true });
    expect(await sweep.run()).toEqual({
      handled: true,
      reason: "memory-core: short-term dreaming processed",
    });
    expect(sweep.narratives).toHaveLength(0);
    const dreams = await sweep.readDreams();
    expect(diaryEntryCount(dreams)).toBe(0);
  });
});
