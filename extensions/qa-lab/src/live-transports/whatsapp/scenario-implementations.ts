import type { WhatsAppQaScenarioImplementation } from "./whatsapp-live.contracts.js";
import * as capabilities from "./whatsapp-live.scenario-implementations.capabilities.js";
import * as conversation from "./whatsapp-live.scenario-implementations.conversation.js";
import * as delivery from "./whatsapp-live.scenario-implementations.delivery.js";
import * as userPath from "./whatsapp-live.scenario-implementations.user-path.js";

export const whatsappScenarioImplementations: Record<string, WhatsAppQaScenarioImplementation> = {
  ...capabilities,
  ...conversation,
  ...delivery,
  ...userPath,
};
