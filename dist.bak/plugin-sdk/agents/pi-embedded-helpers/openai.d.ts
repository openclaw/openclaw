import type { AgentMessage } from "@mariozechner/pi-agent-core";
/**
 * OpenAI Responses API can reject transcripts that contain a standalone `reasoning` item id
 * without the required following item.
 *
 * OpenClaw persists provider-specific reasoning metadata in `thinkingSignature`; if that metadata
 * is incomplete, drop the block to keep history usable.
 */
export declare function downgradeOpenAIReasoningBlocks(messages: AgentMessage[]): AgentMessage[];
