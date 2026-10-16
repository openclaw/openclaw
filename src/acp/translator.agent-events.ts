import type { AgentSideConnection, SessionUpdate } from "@agentclientprotocol/sdk";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { mergeChatStreamMessage } from "../../packages/gateway-client/src/chat-stream-message.js";
import type { EventFrame } from "../../packages/gateway-protocol/src/index.js";
import type { GatewayClient } from "../gateway/client.js";
import {
  extractToolCallContent,
  extractToolCallLocations,
  formatToolTitle,
  inferToolKind,
} from "./event-mapper.js";
import {
  buildAcpPermissionRequest,
  parseGatewayExecApprovalEventData,
  parseGatewayExecApprovalRequestEventPayload,
  resolveGatewayDecisionFromPermissionOutcome,
  type GatewayExecApprovalDecision,
  type GatewayExecApprovalDetails,
  type GatewayExecApprovalEvent,
} from "./permission-relay.js";
import type { AcpPendingApprovalRelay, AcpPendingPrompt } from "./translator.prompt-state.js";
import type { AcpTranslatorSessionUpdates } from "./translator.session-updates.js";

export class AcpTranslatorAgentEvents {
  constructor(
    private readonly connection: AgentSideConnection,
    private readonly gateway: GatewayClient,
    private readonly sessionUpdates: AcpTranslatorSessionUpdates,
    private readonly pendingPrompts: Map<string, AcpPendingPrompt>,
    private readonly approvalRelays: Map<string, AcpPendingApprovalRelay>,
    private readonly findPendingBySessionKey: (
      sessionKey: string,
      runId?: string,
    ) => AcpPendingPrompt | undefined,
    private readonly log: (msg: string) => void,
  ) {}

  async handleAgentEvent(evt: EventFrame): Promise<void> {
    const payload = evt.payload as Record<string, unknown> | undefined;
    if (!payload) {
      return;
    }
    const stream = payload.stream as string | undefined;
    const runId = payload.runId as string | undefined;
    const data = payload.data as Record<string, unknown> | undefined;
    const sessionKey = payload.sessionKey as string | undefined;
    if (!stream || !data || !sessionKey) {
      return;
    }

    if (stream === "approval") {
      const approvalEvent = parseGatewayExecApprovalEventData(data);
      if (approvalEvent) {
        this.startApprovalRelay({ sessionKey, runId, approvalEvent });
      }
      return;
    }

    if (stream !== "tool" && (stream !== "item" || data.kind !== "preamble")) {
      return;
    }
    const pending = this.findPendingBySessionKey(sessionKey, runId);
    if (!pending) {
      return;
    }

    let update: SessionUpdate;
    if (stream === "item") {
      const text = typeof data.progressText === "string" ? data.progressText.trimEnd() : "";
      if (!text) {
        return;
      }
      const projection = payload.preamble;
      if (
        !isRecord(projection) ||
        (projection.retainedText !== undefined && typeof projection.retainedText !== "string")
      ) {
        return;
      }
      const itemId = normalizeOptionalString(data.itemId) ?? "";
      const preambles = (pending.sentPreambles ??= new Map());
      const isNewPreamble = !preambles.has(itemId);
      let sent = preambles.get(itemId) ?? "";
      const previous = pending.preamblePreview;
      const baseline = previous?.itemId === itemId ? previous.text : sent;
      if (!isNewPreamble && !text.startsWith(baseline)) {
        return;
      }
      let preceding = "";
      if (isNewPreamble && previous) {
        // One retired preview can contain several subsequently identified items.
        sent = previous.sent.slice(previous.text.length).replace(/^\n+/, "");
        preambles.set(previous.itemId, previous.text);
        pending.preamblePreview = undefined;
      }
      if (isNewPreamble && typeof projection.retainedText === "string") {
        sent = "";
        const retained = projection.retainedText.trimEnd();
        const answer = pending.sentText ?? "";
        if (answer.startsWith(retained)) {
          const preview = answer.slice(retained.length).replace(/^\n+/, "");
          if (text.startsWith(preview) || preview.startsWith(text)) {
            sent = preview;
          }
        }
        preceding = retained.startsWith(answer) ? retained.slice(answer.length) : "";
        pending.sentText = retained;
        pending.streamMessage = mergeChatStreamMessage(pending.streamMessage, {
          deltaText: retained,
          replace: true,
        });
      }
      const delta = sent.startsWith(text)
        ? ""
        : text.startsWith(sent)
          ? text.slice(sent.length)
          : text;
      preambles.set(itemId, sent.startsWith(text) ? sent : text);
      if (sent.startsWith(text) && sent.length > text.length) {
        pending.preamblePreview = { itemId, text, sent };
      } else if (pending.preamblePreview?.itemId === itemId) {
        pending.preamblePreview = undefined;
      }
      if (!preceding && !delta) {
        if (isNewPreamble) {
          pending.preambleNeedsSeparator = true;
        }
        return;
      }
      const separator =
        isNewPreamble && !sent && pending.preambleNeedsSeparator && !delta.startsWith("\n")
          ? "\n"
          : "";
      pending.preambleNeedsSeparator = true;
      update = {
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "text",
          text: preceding && delta ? `${preceding}\n\n${delta}` : separator + preceding + delta,
        },
      };
    } else {
      const phase = data.phase as string | undefined;
      const name = data.name as string | undefined;
      const toolCallId = data.toolCallId as string | undefined;
      if (!toolCallId) {
        return;
      }

      if (phase === "start") {
        pending.preamblePreview = undefined;
        pending.sentPreambles?.delete("");
        pending.toolCalls ??= new Map();
        if (pending.toolCalls.has(toolCallId)) {
          return;
        }
        const args = data.args as Record<string, unknown> | undefined;
        const title = formatToolTitle(name, args);
        const kind = inferToolKind(name);
        const locations = extractToolCallLocations(args);
        pending.toolCalls.set(toolCallId, {
          title,
          kind,
          locations,
        });
        update = {
          sessionUpdate: "tool_call",
          toolCallId,
          title,
          status: "in_progress",
          rawInput: args,
          kind,
          locations,
        };
      } else if (phase === "update" || phase === "result") {
        const toolState = pending.toolCalls?.get(toolCallId);
        const result = phase === "update" ? data.partialResult : data.result;
        if (phase === "result") {
          pending.toolCalls?.delete(toolCallId);
        }
        update = {
          sessionUpdate: "tool_call_update",
          toolCallId,
          status: phase === "update" ? "in_progress" : data.isError ? "failed" : "completed",
          rawOutput: result,
          content: extractToolCallContent(result),
          locations: extractToolCallLocations(toolState?.locations, result),
        };
      } else {
        return;
      }
      pending.preambleNeedsSeparator = false;
    }
    await this.sessionUpdates.emit({
      sessionId: pending.sessionId,
      sessionKey: pending.sessionKey,
      ...(pending.ledgerSessionId ? { ledgerSessionId: pending.ledgerSessionId } : {}),
      runId: pending.idempotencyKey,
      record: true,
      update,
    });
  }

  handleExecApprovalRequestEvent(evt: EventFrame): void {
    const payload = evt.payload as Record<string, unknown> | undefined;
    if (!payload) {
      return;
    }
    const approvalEvent = parseGatewayExecApprovalRequestEventPayload(payload);
    if (!approvalEvent) {
      return;
    }
    const request = payload.request as Record<string, unknown> | undefined;
    const sessionKey = normalizeOptionalString(request?.sessionKey);
    if (!sessionKey) {
      return;
    }
    this.startApprovalRelay({ sessionKey, approvalEvent });
  }

  clearApprovalRelaysForPrompt(sessionId: string, runId: string): void {
    for (const [approvalId, relay] of this.approvalRelays) {
      if (relay.sessionId !== sessionId || relay.runId !== runId) {
        continue;
      }
      this.approvalRelays.delete(approvalId);
      if (relay.state === "active") {
        void this.resolveGatewayApproval(approvalId, "deny");
      }
    }
  }

  private startApprovalRelay(params: {
    sessionKey: string;
    runId?: string;
    approvalEvent: GatewayExecApprovalEvent;
  }): void {
    const approvalEvent = params.approvalEvent;
    const existing = this.approvalRelays.get(approvalEvent.approvalId);
    if (existing) {
      void this.retryApprovalRelayDecision(existing);
      return;
    }

    const pending = this.findPendingForApproval(params);
    if (!pending) {
      return;
    }
    const pendingToolCall = approvalEvent.toolCallId
      ? pending.toolCalls?.get(approvalEvent.toolCallId)
      : undefined;
    const correlatedApprovalEvent =
      !approvalEvent.title && pendingToolCall?.kind === "execute"
        ? { ...approvalEvent, title: pendingToolCall.title }
        : approvalEvent;

    const relay: AcpPendingApprovalRelay = {
      approvalId: approvalEvent.approvalId,
      runId: pending.idempotencyKey,
      sessionId: pending.sessionId,
      state: "active",
    };
    this.approvalRelays.set(relay.approvalId, relay);
    void this.runApprovalRelay(relay, correlatedApprovalEvent);
  }

  private findPendingForApproval(params: {
    sessionKey: string;
    runId?: string;
    approvalEvent: GatewayExecApprovalEvent;
  }): AcpPendingPrompt | undefined {
    if (params.runId) {
      return this.findPendingBySessionKey(params.sessionKey, params.runId);
    }
    const toolCallId = params.approvalEvent.toolCallId;
    let match: AcpPendingPrompt | undefined;
    for (const pending of this.pendingPrompts.values()) {
      if (
        pending.sessionKey !== params.sessionKey ||
        (toolCallId && pending.toolCalls?.get(toolCallId)?.kind !== "execute")
      ) {
        continue;
      }
      if (match) {
        return undefined;
      }
      match = pending;
    }
    return match;
  }

  private async runApprovalRelay(
    relay: AcpPendingApprovalRelay,
    approvalEvent: GatewayExecApprovalEvent,
  ): Promise<void> {
    let resolved = false;
    let decision: GatewayExecApprovalDecision | undefined;
    try {
      const details = await this.getGatewayApprovalDetails(relay.approvalId);
      if (!this.isApprovalRelayActive(relay)) {
        resolved = await this.resolveGatewayApproval(relay.approvalId, "deny");
        return;
      }

      const request = buildAcpPermissionRequest({
        sessionId: relay.sessionId,
        event: approvalEvent,
        details,
      });
      try {
        const response = await this.connection.requestPermission(request);
        decision = resolveGatewayDecisionFromPermissionOutcome(response, request.options);
      } catch (err) {
        this.log(`approval relay request failed for ${relay.approvalId}: ${String(err)}`);
      }

      const selectedDecision = this.isApprovalRelayActive(relay) && decision ? decision : "deny";
      resolved = await this.resolveGatewayApproval(relay.approvalId, selectedDecision);
    } finally {
      const current = this.approvalRelays.get(relay.approvalId);
      if (current === relay && current.state === "active") {
        if (resolved) {
          // Keep completed relays until prompt cleanup as replay/dedup sentinels.
          current.state = "completed";
        } else if (decision) {
          // Approval broadcasts have no catch-up replay. Retain the user's
          // decision until reconnect or a duplicate event can deliver it.
          current.pendingDecision = decision;
        } else {
          this.approvalRelays.delete(relay.approvalId);
        }
      }
    }
  }

  private async retryApprovalRelayDecision(relay: AcpPendingApprovalRelay): Promise<void> {
    const decision = relay.pendingDecision;
    // Prompt cleanup revokes relay ownership. A detached stored decision must
    // never race its cleanup denial at the Gateway authorization boundary.
    if (!decision || !this.isApprovalRelayActive(relay)) {
      return;
    }
    const resolved = await this.resolveGatewayApproval(relay.approvalId, decision);
    if (!resolved || !this.isApprovalRelayActive(relay)) {
      return;
    }
    relay.pendingDecision = undefined;
    relay.state = "completed";
  }

  async replayApprovalDecisionsOnReconnect(): Promise<void> {
    for (const relay of this.approvalRelays.values()) {
      await this.retryApprovalRelayDecision(relay);
    }
  }

  private async getGatewayApprovalDetails(
    approvalId: string,
  ): Promise<GatewayExecApprovalDetails | null> {
    try {
      return await this.gateway.request<GatewayExecApprovalDetails>("exec.approval.get", {
        id: approvalId,
      });
    } catch (err) {
      this.log(`approval relay hydrate failed for ${approvalId}: ${String(err)}`);
      return null;
    }
  }

  private async resolveGatewayApproval(
    approvalId: string,
    decision: GatewayExecApprovalDecision,
  ): Promise<boolean> {
    try {
      await this.gateway.request("exec.approval.resolve", {
        id: approvalId,
        decision,
      });
      return true;
    } catch (err) {
      this.log(`approval relay resolve failed for ${approvalId}: ${String(err)}`);
      return false;
    }
  }

  private isApprovalRelayActive(relay: AcpPendingApprovalRelay): boolean {
    return (
      this.approvalRelays.get(relay.approvalId) === relay &&
      relay.state === "active" &&
      this.pendingPrompts.get(relay.sessionId)?.idempotencyKey === relay.runId
    );
  }
}
