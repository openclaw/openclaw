const TOPIC_AGENT_MAP: Record<string, string> = {
  claude: "main",
  codex: "coder",
  review: "main",
  deploy: "main",
};

export function resolveAgentFromTopic(topicName: string): string {
  const normalized = topicName.toLowerCase().replace(/[^a-z]/g, "");
  for (const [key, agentId] of Object.entries(TOPIC_AGENT_MAP)) {
    if (normalized.includes(key)) return agentId;
  }
  return "main";
}

export function buildSessionKeyFromTopic(topicId: number | string): string {
  return `superclaw-topic-${topicId}`;
}

export function resolveDeliveryTopic(taskType: string): string {
  switch (taskType) {
    case "coding":
      return "codex";
    case "review":
      return "review";
    case "deploy":
      return "deploy";
    case "report":
      return "reports";
    default:
      return "general";
  }
}
