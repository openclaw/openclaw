/** Match the provider's final contiguous text-output run, excluding earlier drafts. */
export function finalResearchOutput(steps: unknown[]): Record<string, unknown>[] {
  const selected: Record<string, unknown>[] = [];
  let collecting = false;
  outer: for (let i = steps.length - 1; i >= 0; i--) {
    const raw = steps[i];
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error("Invalid interaction step");
    }
    const step = raw as Record<string, unknown>;
    if (step.type === "user_input") {
      break;
    }
    if (step.type === "thought") {
      continue;
    }
    if (step.type !== "model_output") {
      if (collecting) {
        break;
      }
      continue;
    }
    if (step.content === undefined) {
      continue;
    }
    if (!Array.isArray(step.content)) {
      throw new Error("Invalid model output");
    }
    for (let j = step.content.length - 1; j >= 0; j--) {
      const item = step.content[j];
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        throw new Error("Invalid model content");
      }
      if (item.type === "text") {
        collecting = true;
        selected.push(item as Record<string, unknown>);
      } else if (collecting) {
        break outer;
      }
    }
  }
  return selected.toReversed();
}
