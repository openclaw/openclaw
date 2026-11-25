import type { WhatsAppQaScenarioImplementation } from "./whatsapp-live.contracts.js";
import { whatsappCapabilityScenarios } from "./whatsapp-live.scenario-implementations.capabilities.js";
import { whatsappConversationScenarios } from "./whatsapp-live.scenario-implementations.conversation.js";
import { whatsappDeliveryScenarios } from "./whatsapp-live.scenario-implementations.delivery.js";
import { whatsappUserPathScenarios } from "./whatsapp-live.scenario-implementations.user-path.js";

export const whatsappScenarioImplementations: Record<string, WhatsAppQaScenarioImplementation> = {
  ...whatsappCapabilityScenarios,
  ...whatsappConversationScenarios,
  ...whatsappDeliveryScenarios,
  ...whatsappUserPathScenarios,
};
