import type {
  CompleteSimpleFn,
  StreamFn,
  ValidateToolArgumentsFn,
} from "../../../packages/agent-core/src/llm.js";
import { configureAgentCoreRuntime } from "../../../packages/agent-core/src/runtime-deps.js";
import { completeSimple, streamSimple, validateToolArguments } from "../../plugin-sdk/llm.js";

configureAgentCoreRuntime({
  completeSimple: completeSimple as unknown as CompleteSimpleFn,
  streamSimple: streamSimple as unknown as StreamFn,
  validateToolArguments: validateToolArguments as unknown as ValidateToolArgumentsFn,
});

// OpenClaw-owned reusable agent core
export * from "../../../packages/agent-core/src/index.js";
// Proxy utilities
export * from "./proxy.js";
