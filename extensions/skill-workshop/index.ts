import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { registerSkillWorkshopCli } from "./src/cli.js";
import { registerSkillWorkshopGatewayMethods } from "./src/gateway-methods.js";
import { workshopLearnContribution } from "./src/learn-contribution.js";
import { registerSkillWorkshopReview } from "./src/review-service.js";
import { setWorkshopRuntime } from "./src/runtime.js";
import { registerSkillWorkshopTool } from "./src/tool-factory.js";

// Skill Workshop: the per-agent learned skills folder (manifest `agentSkillsDir`), the
// skill_workshop tool, background review and daily maintenance, /learn skills guidance, the
// `openclaw skills workshop` CLI and the `skills.workshop.*` Gateway methods.
export default definePluginEntry({
  id: "skill-workshop",
  name: "Skill Workshop",
  description: "Learned skills each agent saves from its own work.",
  register(api) {
    setWorkshopRuntime(api.runtime);
    registerSkillWorkshopTool(api);
    registerSkillWorkshopReview(api);
    api.registerLearnContribution(workshopLearnContribution);
    registerSkillWorkshopCli(api);
    registerSkillWorkshopGatewayMethods(api);
  },
});
