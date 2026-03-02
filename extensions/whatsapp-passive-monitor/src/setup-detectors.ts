import { createDetectorRegistry } from "./detector-registry.ts";
import { meetingDetector } from "./detectors/meeting.ts";
import type { AgentRepository } from "./repository/agent-repository.ts";
import type { MessageRepository } from "./repository/message-repository.ts";
import type { OllamaRepository } from "./repository/ollama-repository.ts";

// Initializes all detectors and registers them in a DetectorRegistry.
// Repos are passed in since they need runtime config.
export const setupDetectors = (repos: {
  messageRepo: MessageRepository;
  ollama: OllamaRepository;
  agentRepo: AgentRepository;
}) => {
  const registry = createDetectorRegistry();

  registry.add(meetingDetector(repos));
  // Future: registry.add(eventDetector({ ... }));

  return registry;
};
