// Covers image probe retry outcomes and diagnostic redaction.
import { describe, expect, it } from "vitest";
import { runLiveModelImageProbeWithRetry } from "./test-helpers/live-model-turn-probes.js";

function createImageProbeRunner(responses: string[]) {
  const attempts: Array<1 | 2> = [];
  return {
    attempts,
    run: async (attempt: 1 | 2) => {
      attempts.push(attempt);
      const response = responses[attempt - 1];
      if (response === undefined) {
        throw new Error(`Unexpected image probe attempt ${attempt}`);
      }
      return response;
    },
  };
}

describe("live model turn probes", () => {
  it("retries one mismatched image reply and accepts only a matching retry", async () => {
    const { attempts, run } = createImageProbeRunner(["blue", "OK"]);
    const retries: string[] = [];

    await expect(
      runLiveModelImageProbeWithRetry({
        run,
        onRetry: (firstText) => retries.push(firstText),
      }),
    ).resolves.toBe("OK");
    expect(attempts).toEqual([1, 2]);
    expect(retries).toEqual(["blue"]);
  });

  it("does not retry an image reply that already matches", async () => {
    const { attempts, run } = createImageProbeRunner(["OK"]);
    const retries: string[] = [];

    await expect(
      runLiveModelImageProbeWithRetry({
        run,
        onRetry: (firstText) => retries.push(firstText),
      }),
    ).resolves.toBe("OK");
    expect(attempts).toEqual([1]);
    expect(retries).toEqual([]);
  });

  it("does not retry provider errors", async () => {
    const attempts: Array<1 | 2> = [];
    const retries: string[] = [];
    const run = async (attempt: 1 | 2): Promise<string> => {
      attempts.push(attempt);
      throw new Error("boom");
    };

    await expect(
      runLiveModelImageProbeWithRetry({
        run,
        onRetry: (firstText) => retries.push(firstText),
      }),
    ).rejects.toThrow("boom");
    expect(attempts).toEqual([1]);
    expect(retries).toEqual([]);
  });

  it("does not turn a mismatched image reply into an empty-response skip", async () => {
    const { run } = createImageProbeRunner(["blue", ""]);

    await expect(runLiveModelImageProbeWithRetry({ run, onRetry: () => {} })).rejects.toThrow(
      "attempt 2: <empty>",
    );
  });

  it("redacts nonmatching image replies from failure diagnostics", async () => {
    const { run } = createImageProbeRunner(["first private reply", "second private reply"]);

    const error = await runLiveModelImageProbeWithRetry({ run, onRetry: () => {} }).catch(
      (cause: unknown) => String(cause),
    );
    expect(error).toContain("<non-matching response:");
    expect(error).not.toContain("private reply");
  });
});
