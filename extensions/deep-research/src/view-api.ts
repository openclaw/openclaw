import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { Type } from "typebox";
import { researchRequestSchema } from "./contract.js";
import { hash, ResearchStartRejectedError } from "./job-state.js";
import type { ResearchJobs } from "./jobs.js";
import { parseValue } from "./validation.js";
import { projectResearchJob } from "./view-projection.js";

const identity = {
  sessionKey: Type.String({ minLength: 1, maxLength: 512 }),
  agentId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
};
const selector = { ...identity, jobId: Type.String({ minLength: 1, maxLength: 64 }) };
const incarnationSelector = { incarnation: Type.String({ minLength: 1, maxLength: 128 }) };
const schemas = {
  list: Type.Object(identity, { additionalProperties: false }),
  read: Type.Object(selector, { additionalProperties: false }),
  start: Type.Object(
    {
      ...identity,
      ...incarnationSelector,
      request: researchRequestSchema,
      idempotencyKey: Type.String({ minLength: 1, maxLength: 128 }),
    },
    { additionalProperties: false },
  ),
  cancel: Type.Object({ ...selector, ...incarnationSelector }, { additionalProperties: false }),
  resume: Type.Object({ ...selector, ...incarnationSelector }, { additionalProperties: false }),
};

/** No saved descriptors confer authority. Every call enters the native session gate. */
export function registerResearchViewApi(
  api: OpenClawPluginApi,
  getJobs: () => ResearchJobs | undefined,
) {
  for (const action of ["list", "read", "start", "cancel", "resume"] as const) {
    api.registerGatewayMethod(
      `deep-research.view.v1.${action}`,
      async (options) => {
        let mayHaveAccepted = false;
        try {
          const authority = options.sessionAccessAuthority;
          if (!authority) {
            throw new Error("Research requires current Gateway session access.");
          }
          const assertCurrent = () => {
            options.signal?.throwIfAborted();
            options.assertHandlerCurrent?.();
            authority.assertCurrent();
          };
          assertCurrent();
          const input = parseValue(schemas[action], options.params);
          const context = { ...authority.target, assertInvocationCurrent: assertCurrent };
          const jobs = getJobs();
          if (!jobs) {
            options.respond(false, undefined, {
              code: "UNAVAILABLE",
              message: "Research service is starting. Retry shortly.",
              retryable: true,
            });
            return;
          }
          const incarnation = hash(
            JSON.stringify([
              authority.target.sessionId,
              authority.target.lifecycleRevision ?? null,
            ]),
          );
          if (
            action !== "list" &&
            action !== "read" &&
            (!("incarnation" in input) || input.incarnation !== incarnation)
          ) {
            throw new ResearchStartRejectedError(
              "Conversation changed. Refresh research before acting.",
            );
          }
          if (action === "list") {
            const entries = await jobs.list(context);
            assertCurrent();
            options.respond(true, {
              version: 1,
              sessionId: authority.target.sessionId,
              incarnation,
              jobs: entries.map((job) => {
                const { jobId, title, state, phase, summary, createdAt, counts } =
                  projectResearchJob(job);
                return {
                  jobId,
                  title,
                  state,
                  phase,
                  summary,
                  createdAt,
                  counts,
                };
              }),
            });
            return;
          }
          mayHaveAccepted = action === "start";
          const job =
            action === "start" && "request" in input
              ? await jobs.start(
                  input.request,
                  hash(`${incarnation}\n${input.idempotencyKey}`),
                  context,
                  options.signal,
                  undefined,
                  true,
                )
              : await jobs.read("jobId" in input ? input.jobId : "", context);
          assertCurrent();
          const updated =
            action === "cancel"
              ? await jobs.cancel(job, context, options.signal, true)
              : action === "resume"
                ? jobs.requestResume(job, context)
                : job;
          assertCurrent();
          options.respond(true, {
            version: 1,
            sessionId: authority.target.sessionId,
            incarnation,
            job: projectResearchJob(updated),
          });
        } catch (error) {
          options.respond(false, undefined, {
            code: "INVALID_REQUEST",
            message: error instanceof Error ? error.message : "Research view request failed.",
            ...(action === "start" &&
            (!mayHaveAccepted || error instanceof ResearchStartRejectedError)
              ? { details: { code: "RESEARCH_START_REJECTED" } }
              : {}),
          });
        }
      },
      {
        // The current native session gate requires operator.write, including pure reads.
        scope: "operator.write",
        sessionAccess: { mode: "write", requiredTool: "deep_research" },
      },
    );
  }
}
