export function createModelFixture(id: string, inputModalities?: string[]) {
  return {
    id,
    model: id,
    displayName: id,
    description: id.toUpperCase(),
    hidden: false,
    isDefault: false,
    defaultReasoningEffort: "medium",
    supportedReasoningEfforts: [],
    ...(inputModalities ? { inputModalities } : {}),
  };
}
