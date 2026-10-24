// Keep retired ownership configuration visible until the operator completes cleanup.
export const legacyConfigRules = [
  {
    path: ["plugins", "entries", "agentsapi", "config", "executorController"],
    message:
      "Agents API executorController is no longer supported. Retire controlled sessions with the previous OpenClaw version and original controller plugin, then remove executorController and configure an external executor lifecycle owner before upgrading. Doctor preserves this configuration until cleanup is complete.",
  },
];
