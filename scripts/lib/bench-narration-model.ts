import type { ProgressNarrationInput } from "../../src/auto-reply/reply/progress-narrator-model.js";

export const narrationFixture = {
  preparations: 0,
  active: 0,
  maxActive: 0,
  inputs: [] as Array<ProgressNarrationInput & { simulatedAtMs: number }>,
  blocked: undefined as Promise<void> | undefined,
};

export async function prepareNarrationModel() {
  narrationFixture.preparations++;
  return { provider: "benchmark", model: "narrator" };
}

export async function generateNarrationWithUtilityModel(params: {
  input: ProgressNarrationInput;
  abortSignal: AbortSignal;
}) {
  narrationFixture.inputs.push({ ...params.input, simulatedAtMs: Date.now() });
  narrationFixture.active++;
  narrationFixture.maxActive = Math.max(narrationFixture.maxActive, narrationFixture.active);
  try {
    await narrationFixture.blocked;
    params.abortSignal.throwIfAborted();
    return { text: `Update ${narrationFixture.inputs.length}.` };
  } finally {
    narrationFixture.active--;
  }
}
