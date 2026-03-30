/**
 * Default JSON Schemas for OpenClaw Kafka events.
 *
 * These are registered with the Schema Registry (when configured) to ensure
 * data quality and enable schema evolution for downstream consumers.
 */

export const ENVELOPE_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "OpenClawEvent",
  description: "Event envelope published by the openclaw-kafka-producer plugin",
  type: "object",
  properties: {
    stream: {
      type: "string",
      description: "Hook that produced this event",
      enum: [
        "message_sent",
        "message_received",
        "after_tool_call",
        "session_start",
        "session_end",
        "agent_end",
      ],
    },
    ts: {
      type: "integer",
      description: "Event timestamp in milliseconds since epoch",
    },
    agentId: {
      type: "string",
      description: "Agent that produced this event",
    },
    sessionKey: {
      type: "string",
      description: "Full OpenClaw session key",
    },
    runId: {
      type: "string",
      description: "Agent run identifier",
    },
    channelId: {
      type: ["string", "null"],
      description: "Channel identifier (telegram, discord, slack, etc.)",
    },
    accountId: {
      type: ["string", "null"],
      description: "Channel account identifier",
    },
    data: {
      type: "object",
      description: "Hook-specific event payload",
    },
  },
  required: ["stream", "ts", "agentId", "sessionKey", "data"],
};

export const ENVELOPE_SCHEMA_STRING = JSON.stringify(ENVELOPE_SCHEMA);
