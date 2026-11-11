// Verifies the small lifecycle callback adapter used during agent attempts.
import { describe, expect, it } from "vitest";
import {
  createAgentAttemptLifecycleCallbacks,
  type AgentAttemptLifecycleState,
} from "./attempt-callbacks.js";

describe("createAgentAttemptLifecycleCallbacks", () => {
  it("tracks terminal lifecycle phases", async () => {
    const state = {
      lifecycleFinishing: false,
      lifecycleEnded: false,
    };
    const callbacks = createAgentAttemptLifecycleCallbacks(state);

    await callbacks.onAgentEvent({ stream: "lifecycle", data: { phase: "start" } });
    expect(state.lifecycleEnded).toBe(false);

    await callbacks.onAgentEvent({ stream: "lifecycle", data: { phase: "end" } });
    expect(state.lifecycleEnded).toBe(true);
  });

  it("retains deferred lifecycle errors without marking the attempt terminal", async () => {
    const state: AgentAttemptLifecycleState = {
      lifecycleFinishing: false,
      lifecycleEnded: false,
    };
    const callbacks = createAgentAttemptLifecycleCallbacks(state);

    await callbacks.onAgentEvent({
      stream: "lifecycle",
      data: { phase: "finishing", error: "provider failed" },
    });

    expect(state.lifecycleError).toBe("provider failed");
    expect(state.lifecycleFinishing).toBe(true);
    expect(state.lifecycleEnded).toBe(false);
  });

  it("replaces a failed candidate lifecycle when a retry starts", async () => {
    const state: AgentAttemptLifecycleState = {
      lifecycleError: "provider failed",
      lifecycleErrorObservation: { provider: "openai", httpStatus: 502 },
      lifecycleFinishing: true,
      lifecycleEnded: false,
    };
    const callbacks = createAgentAttemptLifecycleCallbacks(state);

    await callbacks.onAgentEvent({ stream: "lifecycle", data: { phase: "start" } });

    expect(state).toEqual({
      lifecycleError: undefined,
      lifecycleErrorObservation: undefined,
      lifecycleFinishing: false,
      lifecycleEnded: false,
    });
  });
});
