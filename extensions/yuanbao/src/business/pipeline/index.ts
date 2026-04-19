/**
 * Message processing pipeline module.
 *
 * Exports pipeline engine, types, and default pipeline factory.
 */

export { MessagePipeline } from "./engine.js";
export { createPipeline } from "./create.js";
export type { PipelineContext, Middleware, MiddlewareDescriptor } from "./types.js";
