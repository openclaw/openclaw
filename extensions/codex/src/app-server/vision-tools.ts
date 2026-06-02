export function filterToolsForVisionInputs<T extends { name?: string }>(
  tools: T[],
  params: {
    modelHasVision: boolean;
    hasInboundImages: boolean;
  },
): T[] {
  if (!params.modelHasVision || !params.hasInboundImages) {
    return tools;
  }
  return tools.filter((tool) => {
    try {
      return tool.name !== "image";
    } catch {
      return true;
    }
  });
}
