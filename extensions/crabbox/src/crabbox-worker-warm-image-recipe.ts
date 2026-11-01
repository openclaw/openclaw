import type { WorkerProvider } from "openclaw/plugin-sdk/plugin-entry";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

type PreparedProject = Awaited<
  ReturnType<
    NonNullable<NonNullable<Parameters<WorkerProvider["provision"]>[2]>["project"]>["prepare"]
  >
>;
export type CrabboxProjectPreparationMetadata = Pick<
  PreparedProject,
  "recipePreparation" | "captureSkipped"
>;
export type RecipePreparation = NonNullable<PreparedProject["recipePreparation"]>;

export function normalizeRecipePreparation(value: unknown): RecipePreparation | undefined {
  if (
    !isRecord(value) ||
    (value.source !== "devcontainer" &&
      value.source !== "script" &&
      value.source !== "detected" &&
      value.source !== "none")
  ) {
    return undefined;
  }
  const recipe: RecipePreparation = { source: value.source };
  if (typeof value.note === "string") {
    recipe.note = value.note.slice(0, 1024);
  }
  if (typeof value.ignoredPropertiesNote === "string") {
    recipe.ignoredPropertiesNote = value.ignoredPropertiesNote.slice(0, 1024);
  }
  if (isRecord(value.phaseDurationsMs)) {
    const durations: NonNullable<RecipePreparation["phaseDurationsMs"]> = {};
    for (const phase of ["onCreate", "updateContent", "detectedInstall"] as const) {
      const duration = value.phaseDurationsMs[phase];
      if (typeof duration === "number" && Number.isFinite(duration) && duration >= 0) {
        durations[phase] = duration;
      }
    }
    recipe.phaseDurationsMs = durations;
  }
  if (isRecord(value.failure) && typeof value.failure.reason === "string") {
    recipe.failure = { reason: value.failure.reason.slice(0, 1024) };
    if (typeof value.failure.outputTail === "string") {
      let tail = Buffer.from(value.failure.outputTail).subarray(-16_384).toString("utf8");
      // A byte cut through UTF-8 can decode to a larger replacement character.
      while (Buffer.byteLength(tail) > 16_384) {
        tail = tail.slice(1);
      }
      recipe.failure.outputTail = tail;
    }
  }
  return recipe;
}
