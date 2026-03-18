export function createPlan(goal, observation) {
  return {
    goal,
    steps: [
      {
        step: "analyze",
        expected: "understand UI"
      },
      {
        step: "propose-action",
        action: {
          type: "click",
          target: observation.elements?.[0]?.label || "unknown"
        }
      }
    ],
    risk: "LOW",
    confidence: 0.5
  };
}
