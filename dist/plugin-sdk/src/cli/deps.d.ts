import type { OutboundSendDeps } from "../infra/outbound/send-deps.js";
import type { CliDeps } from "./deps.types.js";
/**
 * Lazy-loaded per-channel send functions, keyed by channel ID.
 * Values are proxy functions that dynamically import the real module on first use.
 */
export type { CliDeps } from "./deps.types.js";
export declare function createDefaultDeps(): CliDeps;
export declare function createOutboundSendDeps(deps: CliDeps): OutboundSendDeps;
