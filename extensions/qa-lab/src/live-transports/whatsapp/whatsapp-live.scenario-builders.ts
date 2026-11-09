import { randomUUID } from "node:crypto";
import type {
  WhatsAppQaMessageScenarioRun,
  WhatsAppQaScenarioImplementation,
} from "./whatsapp-live.contracts.js";

type MessageDefaults = "configMode" | "expectReply" | "matchText" | "target";

export function createWhatsAppMessageScenario({
  marker,
  buildRun,
  ...metadata
}: Omit<WhatsAppQaScenarioImplementation, "buildRun"> & {
  marker: string;
  buildRun: (
    token: string,
  ) => Omit<WhatsAppQaMessageScenarioRun, MessageDefaults> &
    Partial<Pick<WhatsAppQaMessageScenarioRun, MessageDefaults>>;
}): WhatsAppQaScenarioImplementation {
  return {
    ...metadata,
    buildRun: () => {
      const token = `${marker}_${randomUUID().slice(0, 8).toUpperCase()}`;
      return {
        configMode: "allowlist",
        expectReply: true,
        matchText: token,
        target: "dm",
        ...buildRun(token),
      };
    },
  };
}
