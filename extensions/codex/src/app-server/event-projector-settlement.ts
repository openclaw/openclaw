import { AgentHarnessProjectionSettlement } from "openclaw/plugin-sdk/agent-harness-attempt-runtime";
import type { EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams } from "openclaw/plugin-sdk/agent-harness-runtime";
import type { CodexTurn } from "./protocol.js";

export class CodexProjectionSettlement extends AgentHarnessProjectionSettlement<EmbeddedRunAttemptParams> {
  terminalReceipt: CodexTurn | undefined;
  turnTainted = false;

  constructor(params: EmbeddedRunAttemptParams, isActive: () => boolean) {
    super(params, isActive, { label: "codex app-server" });
  }

  get completedAnswer() {
    const turn = this.terminalReceipt;
    // Codex 0.153.0 turn/completed carries the last assistant item as a summary.
    const answer = turn?.items?.findLast(
      (item) =>
        item.type === "agentMessage" &&
        item.phase !== "commentary" &&
        item.delivery !== "async" &&
        typeof item.text === "string" &&
        item.text.trim().length > 0,
    );
    return turn?.status === "completed" && answer ? { turn, answer } : undefined;
  }
}
