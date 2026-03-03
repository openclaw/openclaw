/**
 * Tool Result Summary Extension Entry Point
 *
 * Opt-in summary storage and retrieval for tool execution results.
 *
 * When enabled, this extension will:
 * 1. Generate LLM summaries of large tool outputs
 * 2. Store results with summaries in a vector database
 * 3. Inject relevant results into future agent turns
 *
 * This helps maintain context across long conversations by allowing
 * the agent to recall relevant tool results from previous turns.
 */

export { default } from "./tool-result-summary/extension.js";

export {
  computeEffectiveSettings,
  DEFAULT_TOOL_RESULT_SUMMARY_CONFIG,
} from "./tool-result-summary/settings.js";

export type {
  ToolResultSummaryConfig,
  ToolResultSummaryUserConfig,
} from "./tool-result-summary/types.js";
