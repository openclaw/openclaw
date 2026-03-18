export function normalizeObservation(input) {
  return {
    app: input.app,
    windowTitle: input.windowTitle,
    textBlocks: input.textBlocks || [],
    elements: input.elements || [],
    timestamp: Date.now()
  };
}
