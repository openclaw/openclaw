// Focused coverage for the flow skip action (#118489), kept in its own file so
// the runtime-pair scenario suite stays within the max-lines budget.
import { describe, expect, it } from "vitest";
import { QaSuiteScenarioSkipError } from "./errors.js";
import { runLoadedScenarioFlow } from "./scenario-flow-runner.test-support.js";

describe("scenario-flow-runner skip action", () => {
  it("skips a step when the skip condition is met", async () => {
    await expect(
      runLoadedScenarioFlow("qa-channel-failed-tool-terminal-finalization", {
        flow: {
          steps: [
            {
              name: "skips on condition",
              actions: [
                {
                  skip: {
                    expr: "env.condition === true",
                    message: "known-harness-gap openclaw-runtime: test skip",
                  },
                },
              ],
            },
          ],
        },
        api: { env: { condition: true } },
      }),
    ).rejects.toThrow(QaSuiteScenarioSkipError);
  });

  it("continues when the skip condition is not met", async () => {
    await runLoadedScenarioFlow("qa-channel-failed-tool-terminal-finalization", {
      flow: {
        steps: [
          {
            name: "does not skip",
            actions: [
              { skip: { expr: "env.condition === true", message: "should not skip" } },
              { set: "marker", value: "continued" },
            ],
          },
        ],
      },
      api: { env: { condition: false } },
    });
  });
});
