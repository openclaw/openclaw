// Subagent hooks live behind a dedicated barrel so the bundled entry can lazy
// load only the handlers it needs.
export {
  handleSlackSubagentDeliveryTarget,
  handleSlackSubagentEnded,
  handleSlackSubagentSpawning,
} from "./src/subagent-hooks.js";
