import type { ResearchRequest } from "./contract.js";
import type { ResearchExecution } from "./execution.js";
import { ResearchStartRejectedError } from "./job-state.js";
import { assertManagedRequest } from "./managed.js";

/** Validate before any durable job write; callers may safely unlock rejected starts. */
export function assertResearchStart(
  request: ResearchRequest,
  context: ResearchExecution,
): asserts context is ResearchExecution & {
  agentId: string;
  sessionKey: string;
  sessionId: string;
} {
  if (!context.sessionKey || !context.sessionId || !context.agentId) {
    throw new ResearchStartRejectedError("Research requires a current conversation generation.");
  }
  if (request.engine === "google") {
    try {
      assertManagedRequest(request);
    } catch (error) {
      throw new ResearchStartRejectedError(
        error instanceof Error ? error.message : "Invalid managed request",
      );
    }
  }
  if (Buffer.byteLength(JSON.stringify(request)) > 262_144) {
    throw new ResearchStartRejectedError("Research request exceeds the retained input limit.");
  }
}
