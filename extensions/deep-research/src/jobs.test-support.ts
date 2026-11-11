import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  PluginServiceSchedulerV1,
  PluginServiceSessionWorkV1,
} from "openclaw/plugin-sdk/plugin-entry";
import {
  createPluginStateKeyedStoreV2ForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { createTestPluginServiceScheduler } from "openclaw/plugin-sdk/plugin-test-api";
import {
  createCapturedPluginRegistration,
  createPluginRuntimeMock,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { vi } from "vitest";
import type { ResearchExecution } from "./execution.js";
import { ResearchJobs, type ResearchJob } from "./jobs.js";
import { createResearchTool } from "./tool.js";

export async function createResearchJobsFixture(
  fixtureOptions: {
    sessionWork?: Omit<PluginServiceSessionWorkV1, "withCurrent">;
    scheduler?: PluginServiceSchedulerV1;
  },
  registerCleanup: (close: () => Promise<void>) => void,
) {
  const directory = await mkdtemp(path.join(tmpdir(), "research-jobs-test-"));
  const runtime = createPluginRuntimeMock();
  let jobsNamespace: string | undefined;
  runtime.state.openKeyedStoreV2 = (options, authority = { assertCurrent() {} }) => {
    if (options.namespace.startsWith("research-jobs-v1-")) {
      jobsNamespace = options.namespace;
    }
    return createPluginStateKeyedStoreV2ForTests(
      "deep-research",
      { ...options, env: { OPENCLAW_STATE_DIR: directory } },
      authority,
    );
  };
  const readStore = () => {
    if (!jobsNamespace) {
      throw new Error("No job store was opened by the feature");
    }
    return runtime.state.openKeyedStoreV2<ResearchJob>({
      namespace: jobsNamespace,
      maxEntries: 32,
      overflowPolicy: "reject-new",
    });
  };
  const api = { ...createCapturedPluginRegistration({ id: "deep-research" }).api, runtime };
  const scheduler = fixtureOptions.scheduler ?? createTestPluginServiceScheduler();
  const current = vi.fn();
  const context: ResearchExecution & { agentId: string; sessionKey: string; sessionId: string } = {
    sessionKey: "agent:main:research-fixture",
    sessionId: "generation-1",
    agentId: "main",
    assertInvocationCurrent: current,
  };
  // Synthetic host current-target issuer; real authority is covered by Gateway integration.
  const target = () => ({
    agentId: context.agentId,
    sessionKey: context.sessionKey,
    sessionId: context.sessionId,
    ...(context.lifecycleRevision ? { lifecycleRevision: context.lifecycleRevision } : {}),
  });
  const sessionWork: PluginServiceSessionWorkV1 = {
    version: 1,
    admit: async () => ({ recoverable: false, target: target() }),
    run: async () => ({ status: "unavailable", reason: "No fixture recovery source" }),
    ...fixtureOptions.sessionWork,
    withCurrent: async (_input, work) => {
      const captured = target();
      const assertCurrent = () => {
        current();
        if (context.lifecycleRevision !== captured.lifecycleRevision) {
          throw new Error("Fixture incarnation retired");
        }
      };
      assertCurrent();
      const value = await work({ target: captured, signal: scheduler.signal, assertCurrent });
      assertCurrent();
      return value;
    },
  };
  const jobs = new ResearchJobs(api, scheduler, sessionWork);
  const tool = createResearchTool(api, context, jobs);
  registerCleanup(async () => {
    await scheduler.stop();
    resetPluginStateStoreForTests();
    await rm(directory, { recursive: true, force: true });
  });
  return { jobs, api, runtime, scheduler, context, tool, current, readStore, sessionWork };
}
export const descriptor = {
  version: 1,
  ok: true,
  value: {
    version: 1,
    kind: "managed-research",
    provider: "google",
    agent: "research-agent",
    authModes: ["api-key"],
    citationEvidence: "provider-attributed",
    storageRequired: true,
    hardBudgets: { model: false, search: false, tokens: false },
    idempotentStart: false,
  },
};
export const handle = {
  interactionId: "remote-research-fixture",
  profileId: "google:research-fixture",
};
export const completed = {
  version: 1,
  ok: true,
  value: {
    state: "completed",
    handle,
    report: "A provider report.",
    citations: [{ url: "https://example.org/source" }],
    usageTokens: 100,
  },
};
