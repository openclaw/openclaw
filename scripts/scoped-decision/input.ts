import type { ClassifierInput } from "./types.ts";

/** Copy only bounded classifier fields, before any approval or awaited work. */
export function projectClassifierInput(value: unknown): ClassifierInput {
  if (
    typeof value !== "object" ||
    value === null ||
    !("message" in value) ||
    typeof value.message !== "string" ||
    value.message.length > 4096 ||
    !("activities" in value) ||
    !Array.isArray(value.activities) ||
    value.activities.length > 8
  ) {
    throw new Error("Invalid classifier context.");
  }
  const activities: ClassifierInput["activities"] = [];
  const ids = new Set<string>();
  for (const entry of value.activities) {
    const activity: unknown = entry;
    if (
      typeof activity !== "object" ||
      activity === null ||
      !("id" in activity) ||
      typeof activity.id !== "string" ||
      !/^[a-z][a-z0-9_-]{0,63}$/.test(activity.id) ||
      ids.has(activity.id) ||
      !("label" in activity) ||
      typeof activity.label !== "string" ||
      activity.label.length < 1 ||
      activity.label.length > 64 ||
      !("currentDirection" in activity) ||
      (activity.currentDirection !== "A" && activity.currentDirection !== "B")
    ) {
      throw new Error("Invalid or duplicate classifier activity.");
    }
    ids.add(activity.id);
    activities.push({
      id: activity.id,
      label: activity.label,
      currentDirection: activity.currentDirection,
    });
  }
  return { message: value.message, activities };
}
