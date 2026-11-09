import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import { definePluginEntry, type PluginServiceSchedulerV1 } from "openclaw/plugin-sdk/plugin-entry";
import { researchToolDefinition } from "./src/contract.js";
import type { ResearchJobs } from "./src/jobs.js";
import { registerResearchViewApi } from "./src/view-api.js";

const loadTool = createLazyRuntimeModule(() => import("./src/tool.js"));

const loadJobs = createLazyRuntimeModule(() => import("./src/jobs.js"));

export default definePluginEntry({
  id: "deep-research",
  name: "Deep Research",
  description: "Bounded, evidence-backed research",
  register(api) {
    let service: { scheduler: PluginServiceSchedulerV1; jobs: ResearchJobs } | undefined;
    registerResearchViewApi(api, () => {
      if (!service || service.scheduler.signal.aborted) {
        return undefined;
      }
      return service.jobs;
    });
    api.registerService({
      apiVersion: 3,
      id: "deep-research-jobs",
      async start(context) {
        const { ResearchJobs } = await loadJobs();
        context.scheduler.signal.throwIfAborted();
        const jobs = new ResearchJobs(api, context.scheduler, context.sessionWork, () => {
          if (context.scheduler.signal.aborted) {
            return;
          }
          context.scheduler.schedule({
            id: "view-invalidation",
            atMs: context.scheduler.now() + 250,
            mode: "earliest",
            run: async () => {
              context.gatewayEvents?.emit("changed", {}, { scope: "operator.read" });
            },
          });
        });
        service = { scheduler: context.scheduler, jobs };
        await jobs.startRecovery();
      },
      async stop() {
        const owner = service;
        service = undefined;
        await owner?.scheduler.stop();
      },
    });
    api.registerTool(
      {
        contextVersion: 2,
        create: (context) => ({
          ...researchToolDefinition,
          execute: async (id, params, signal, onUpdate) => {
            context.assertInvocationCurrent();
            const owner = service;
            if (!owner) {
              throw new Error("Deep research requires the running Gateway job service.");
            }
            owner.scheduler.signal.throwIfAborted();
            const jobs = owner.jobs;
            return (await loadTool())
              .createResearchTool(api, context, jobs)
              .execute(id, params, signal, (message, jobId) =>
                onUpdate?.({
                  content: [{ type: "text", text: message }],
                  details: { progress: message, ...(jobId ? { version: 1, jobId } : {}) },
                }),
              );
          },
        }),
      },
      { names: ["deep_research"], workspaceAccess: false },
    );
  },
});
