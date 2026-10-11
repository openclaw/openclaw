import type { agentSessionSetPromptPreparation } from "../../sessions/agent-session-prompting.js";
import type { AgentSession } from "../../sessions/agent-session.js";

type PromptPreparation = Parameters<AgentSession[typeof agentSessionSetPromptPreparation]>[0];

/** The fake session consumes the host admission before entering its composed prompt. */
export async function runPreparedTestPrompt(
  getPreparation: () => PromptPreparation,
  run: () => Promise<void>,
): Promise<void> {
  const currentPreparation = getPreparation();
  if (!currentPreparation) {
    return run();
  }
  const admit = await currentPreparation();
  const assertCurrent = () => {
    if (currentPreparation !== getPreparation()) {
      throw new Error("Session prompt preparation is stale after replacement or disposal.");
    }
  };
  assertCurrent();
  let running: Promise<PromiseSettledResult<void>> | undefined;
  const start = (commit?: () => void) => {
    assertCurrent();
    commit?.();
    assertCurrent();
    running = run().then(
      (value) => ({ status: "fulfilled", value }),
      (reason: unknown) => ({ status: "rejected", reason }),
    );
  };
  try {
    if (admit) {
      await admit(start);
    } else {
      start();
    }
  } catch (error) {
    await running;
    throw error;
  }
  if (!running) {
    throw new Error("Session prompt admission did not start the agent loop.");
  }
  const result = await running;
  if (result.status === "rejected") {
    throw result.reason;
  }
}
