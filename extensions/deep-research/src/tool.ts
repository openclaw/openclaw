import type {
  OpenClawPluginApi,
  OpenClawPluginToolContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { jsonResult } from "openclaw/plugin-sdk/tool-results";
import { researchToolDefinition, researchToolSchema } from "./contract.js";
import { RESEARCH_INLINE_VIEW } from "./inline-view-contract.js";
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
          if (job.state === "paused" && !job.cancelRequested) {
            job = await jobs.requestResume(job, current);
          }
          job = await jobs.run(job, current, signal, progress);
        }
        if (input.action === "cancel") {
          job = await jobs.cancel(job, current, signal);
        }
        current.assertInvocationCurrent();
        signal?.throwIfAborted();
        // The same immutable stored result is returned on retries. No channel send is replayed.
        const status = { version: 1, jobId: job.id, state: job.state, progress: job.progress };
        if (input.action === "result") {
          return jsonResult({ ...status, result: job.result });
        }
        if (input.action !== "start" && input.action !== "resume") {
          return jsonResult(status);
        }
        // Starting or resuming work shows its job card where the call happened. The result stays
        // compact so transcripts keep the card; `result` returns retained source text.
        const view = api.inlineView(
          RESEARCH_INLINE_VIEW.id,
          { jobId: job.id },
          {
            version: RESEARCH_INLINE_VIEW.version,
            summary: `Deep research ${job.state}: ${job.progress}`,
          },
        );
        const compact = {
          ...status,
          result: compactResult(job.result),
          fullResult: 'Call action "result" with this jobId for retained source text.',
        };
        return {
          content: [{ type: "text" as const, text: JSON.stringify(compact, null, 2) }],
          details: { ...compact, ...view.details },
        };
      });
    },
  };
}

// Drops retained source text from a start/resume result; the report and findings stay intact.
function compactResult(result: unknown): unknown {
  if (!result || typeof result !== "object" || !("sources" in result)) {
    return result;
  }
  const sources = Array.isArray(result.sources) ? result.sources : [];
  return {
    ...result,
    sources: sources.map((source: unknown) => {
      if (!source || typeof source !== "object") {
        return source;
      }
      const { text: _text, ...rest } = source as Record<string, unknown>;
      return rest;
    }),
  };
}
