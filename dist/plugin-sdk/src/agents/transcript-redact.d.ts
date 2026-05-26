import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { OpenClawConfig } from "../config/types.openclaw.js";
export declare function redactTranscriptMessage(message: AgentMessage, cfg?: OpenClawConfig): AgentMessage;
