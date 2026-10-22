/** Tests the ACP SDK's public JSON Schema against representative protocol payloads. */
import { PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import acpProtocolSchema from "@agentclientprotocol/sdk/schema/schema.json" with { type: "json" };
import { expect, it } from "vitest";
import { type JsonSchemaValue, validateJsonSchemaValue } from "../plugins/schema-validator.js";

type SchemaFixture = [keyof typeof acpProtocolSchema.$defs, unknown, unknown];

const newSession = { cwd: "/tmp/openclaw", mcpServers: [] };
const session = { sessionId: "agent:main:work", ...newSession };
const chunk = {
  sessionUpdate: "agent_message_chunk",
  content: { type: "text", text: "hello" },
};
const fixtures: SchemaFixture[] = [
  [
    "InitializeRequest",
    {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    },
    { protocolVersion: "1", clientCapabilities: {} },
  ],
  ["NewSessionRequest", newSession, { ...newSession, cwd: 42 }],
  [
    "PromptRequest",
    { sessionId: "session-1", prompt: [{ type: "text", text: "hello" }] },
    { sessionId: "session-1", prompt: [{ type: "text" }] },
  ],
  ["SessionNotification", { sessionId: "session-1", update: chunk }, { update: chunk }],
  [
    "ListSessionsRequest",
    { cwd: newSession.cwd, cursor: null },
    { cwd: newSession.cwd, cursor: 123 },
  ],
  ["LoadSessionRequest", session, { sessionId: session.sessionId, mcpServers: [] }],
  ["ResumeSessionRequest", session, { ...session, cwd: 42 }],
  ["CloseSessionRequest", { sessionId: session.sessionId }, { sessionId: null }],
];

it.each(fixtures)("%s validates representative payloads", (name, valid, invalid) => {
  const schema = {
    ...acpProtocolSchema.$defs[name],
    $defs: acpProtocolSchema.$defs,
  } as JsonSchemaValue;
  const validate = (value: unknown) =>
    validateJsonSchemaValue({ schema, cacheKey: `acp:${name}`, value }).ok;
  expect(validate(valid)).toBe(true);
  expect(validate(invalid)).toBe(false);
});
