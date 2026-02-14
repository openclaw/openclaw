import type { ExplorerField } from "../lib/schema-spike.ts";
import { resolveExplorerField } from "../lib/schema-spike.ts";

export type WizardStep = {
  id: string;
  label: string;
  description: string;
  fields: string[];
};

export const WIZARD_STEPS: WizardStep[] = [
  {
    id: "gateway",
    label: "Gateway",
    description: "Core gateway networking and auth settings.",
    fields: [
      "gateway.port",
      "gateway.mode",
      "gateway.bind",
      "gateway.auth.mode",
      "gateway.auth.token",
      "gateway.auth.password",
    ],
  },
  {
    id: "channels",
    label: "Channels",
    description: "Common channel credentials and DM policies.",
    fields: [
      "channels.whatsapp.dmPolicy",
      "channels.telegram.botToken",
      "channels.telegram.dmPolicy",
      "channels.discord.token",
      "channels.discord.dm.policy",
      "channels.slack.botToken",
      "channels.slack.dm.policy",
      "channels.signal.account",
      "channels.signal.dmPolicy",
    ],
  },
  {
    id: "agents",
    label: "Agents",
    description: "Default model + workspace behavior.",
    fields: [
      "agents.defaults.model.primary",
      "agents.defaults.model.fallbacks",
      "agents.defaults.workspace",
      "agents.defaults.repoRoot",
      "agents.defaults.humanDelay.mode",
    ],
  },
  {
    id: "models",
    label: "Models",
    description: "Auth and model catalog data.",
    fields: ["agents.defaults.models", "auth.profiles", "auth.order"],
  },
  {
    id: "messages",
    label: "Messages",
    description: "Reply behavior and acknowledgment defaults.",
    fields: [
      "messages.ackReaction",
      "messages.ackReactionScope",
      "messages.inbound.debounceMs",
      "channels.telegram.streamMode",
    ],
  },
  {
    id: "session",
    label: "Session",
    description: "DM scoping and agent-to-agent behavior.",
    fields: ["session.dmScope", "session.identityLinks", "session.agentToAgent.maxPingPongTurns"],
  },
  {
    id: "tools",
    label: "Tools",
    description: "Web and execution tool defaults.",
    fields: [
      "tools.profile",
      "tools.web.search.enabled",
      "tools.web.search.provider",
      "tools.web.search.apiKey",
      "tools.web.fetch.enabled",
      "tools.exec.applyPatch.enabled",
    ],
  },
];

export function wizardStepFields(step: WizardStep): ExplorerField[] {
  return step.fields
    .map((path) => resolveExplorerField(path))
    .filter((field): field is ExplorerField => field !== null);
}

export function wizardStepByIndex(index: number): WizardStep {
  const clamped = Math.max(0, Math.min(index, WIZARD_STEPS.length - 1));
  return WIZARD_STEPS[clamped] ?? WIZARD_STEPS[0] ?? {
    id: "empty",
    label: "Empty",
    description: "No wizard steps configured.",
    fields: [],
  };
}
