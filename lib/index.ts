/**
 * Smart Router Index
 *
 * Main entry point for the escalation gate system.
 */

export {
  determineLevel,
  executeWithGate,
  cronJobNeedsAI,
  type ExecutionPlan,
  type Handlers,
} from "./escalation-gate.js";

export {
  retrieve,
  store,
  cleanupExpired,
  type MemoryEntry,
  type RetrieveOptions,
} from "./unified-memory.js";

export {
  createTrace,
  loadTraces,
  analyzeTraces,
  generateRecommendations,
  type TraceData,
  type TraceInstance,
  type TraceFilters,
  type TraceAnalysis,
  type Recommendation,
} from "./trace-standard.js";

export {
  processRequest,
  runCronJob,
  classifyRequest,
  type RouterResult,
  type CronJobOptions,
} from "./smart-router.js";
