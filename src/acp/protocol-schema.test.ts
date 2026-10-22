/** Tests the ACP SDK's public JSON Schema against representative protocol payloads. */
import { PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import acpProtocolSchema from "@agentclientprotocol/sdk/schema/schema.json" with { type: "json" };
import { describe, expect, it } from "vitest";
import { type JsonSchemaValue, validateJsonSchemaValue } from "../plugins/schema-validator.js";

type SchemaFixture = {
  name: keyof typeof acpProtocolSchema.$defs;
  valid: unknown;
  invalid: unknown;
};

const newSession = { cwd: "/tmp/openclaw", mcpServers: [] };
const session = { sessionId: "agent:main:work", ...newSession };
const chunk = {
  sessionUpdate: "agent_message_chunk",
  content: { type: "text", text: "hello" },
};
const fixtures: SchemaFixture[] = [
  {
    name: "InitializeRequest",
    valid: {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    },
    invalid: { protocolVersion: "1", clientCapabilities: {} },
  },
  {
    name: "NewSessionRequest",
    valid: newSession,
    invalid: { ...newSession, cwd: 42 },
  },
  {
    name: "PromptRequest",
    valid: { sessionId: "session-1", prompt: [{ type: "text", text: "hello" }] },
    invalid: { sessionId: "session-1", prompt: [{ type: "text" }] },
  },
  {
    name: "SessionNotification",
    valid: { sessionId: "session-1", update: chunk },
    invalid: { update: chunk },
  },
  {
    name: "ListSessionsRequest",
    valid: { cwd: newSession.cwd, cursor: null },
    invalid: { cwd: newSession.cwd, cursor: 123 },
  },
  {
    name: "LoadSessionRequest",
    valid: session,
    invalid: { sessionId: session.sessionId, mcpServers: [] },
  },
  { name: "ResumeSessionRequest", valid: session, invalid: { ...session, cwd: 42 } },
  {
    name: "CloseSessionRequest",
    valid: { sessionId: session.sessionId },
    invalid: { sessionId: null },
  },
];

describe("ACP SDK protocol schema fixtures", () => {
  it.each(fixtures)("$name validates representative payloads", ({ name, valid, invalid }) => {
    const schema = {
      ...acpProtocolSchema.$defs[name],
      $defs: acpProtocolSchema.$defs,
    } as JsonSchemaValue;
    const validate = (value: unknown) =>
      validateJsonSchemaValue({ schema, cacheKey: `acp:${name}`, value }).ok;
    expect(validate(valid)).toBe(true);
    expect(validate(invalid)).toBe(false);
  });
});
