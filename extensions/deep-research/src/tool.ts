import type {
  OpenClawPluginApi,
  OpenClawPluginToolContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { jsonResult } from "openclaw/plugin-sdk/tool-results";
import { researchToolDefinition, researchToolSchema } from "./contract.js";
import type { ResearchJobs } from "./jobs.js";
import { managedClient } from "./managed.js";
import { parseValue } from "./validation.js";

export function createResearchTool(
  api: OpenClawPluginApi,
  context: OpenClawPluginToolContext<2>,
  jobs: ResearchJobs,
) {
  return {
    ...researchToolDefinition,
    async execute(
      _id: string,
      args: unknown,
      signal?: AbortSignal,
      progress: (message: string, jobId?: string) => void = () => {},
    ) {
      context.assertInvocationCurrent();
      signal?.throwIfAborted();
      const input = parseValue(researchToolSchema, args);
      if (input.action === "capabilities") {
        let managed: unknown = {
          available: false,
          reason: "Google research is not activated for this conversation.",
        };
        try {
          const descriptor = await managedClient(api, context)(
            { version: 1, action: "describe" },
            signal ?? AbortSignal.timeout(10_000),
          );
          managed = descriptor.ok ? descriptor : { available: false, reason: descriptor.reason };
        } catch {
          context.assertInvocationCurrent();
          signal?.throwIfAborted();
        }
        return jsonResult({
          version: 1,
          portable: { runtime: "direct-provider", nativeFunctionCallingRequired: false },
          managed,
        });
      }
      return jobs.withCurrent(context, async (current) => {
        let job =
          input.action === "start"
            ? await jobs.start(input.request, input.idempotencyKey, current, signal, progress)
            : await jobs.get(input.jobId, current);
        if (input.action === "resume") {
          job = await jobs.run(job, current, signal, progress);
        }
        if (input.action === "cancel") {
          job = await jobs.cancel(job, current, signal);
        }
        current.assertInvocationCurrent();
        signal?.throwIfAborted();
        // The same immutable stored result is returned on retries. No channel send is replayed.
        return jsonResult({
          version: 1,
          jobId: job.id,
          state: job.state,
          progress: job.progress,
          ...(input.action === "result" || input.action === "start" || input.action === "resume"
            ? { result: job.result }
            : {}),
        });
      });
    },
  };
}
