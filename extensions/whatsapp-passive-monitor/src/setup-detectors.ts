import { createDetectorRegistry } from "./detector-registry.ts";
import { meetingDetector, type MeetingDetectorAgent } from "./detectors/meeting.ts";
import type { AgentRepository } from "./repository/agent-repository.ts";
import type { MessageRepository } from "./repository/message-repository.ts";
import type { Logger } from "./types.ts";

// Initializes all detectors and registers them in a DetectorRegistry.
// Repos and logger are passed in since they need runtime config.
export const setupDetectors = (deps: {
  messageRepo: MessageRepository;
  agents: MeetingDetectorAgent[];
  agentRepo: AgentRepository;
  logger: Logger;
}) => {
  const registry = createDetectorRegistry(deps.logger);

  registry.add(meetingDetector(deps));
  // Future: registry.add(eventDetector({ ... }));

  return registry;
};
