#!/usr/bin/env node
// Synthetic ACP peer shaped like Cursor's `agent acp`: it advertises only `mode` and a
// `category: "model"` select whose values are opaque parameterized IDs, and rejects any
// value it did not advertise with -32602, as Cursor does.
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { Readable, Writable } from "node:stream";
import {
  AgentSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  RequestError,
} from "@agentclientprotocol/sdk";

const catalog = JSON.parse(
  fs.readFileSync(new URL("./cursor-model-catalog.json", import.meta.url), "utf8"),
);
const sessions = new Map();
const configOptions = (state) => [
  {
    id: "mode",
    name: "Mode",
    category: "mode",
    type: "select",
    currentValue: "agent",
    options: [{ value: "agent", name: "Agent" }],
  },
  {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: state.model,
    options: catalog.availableModelIds.map((value) => ({ value, name: value })),
  },
];
const connection = new AgentSideConnection(
  (client) => ({
    async initialize() {
      return { protocolVersion: PROTOCOL_VERSION, agentCapabilities: {}, authMethods: [] };
    },
    async newSession() {
      const sessionId = randomUUID();
      const state = { model: catalog.currentModelId };
      sessions.set(sessionId, state);
      return { sessionId, configOptions: configOptions(state) };
    },
    async setSessionConfigOption({ sessionId, configId, value }) {
      const state = sessions.get(sessionId);
      if (configId !== "model" || !catalog.availableModelIds.includes(value)) {
        throw RequestError.invalidParams(undefined, `unsupported ${configId} value`);
      }
      if (catalog.unselectableModelIds.includes(value)) {
        // Advertised but not selectable for this account (for example a plan limit).
        throw RequestError.internalError(undefined, `${value} is not available on this plan`);
      }
      state.model = value;
      return { configOptions: configOptions(state) };
    },
    async prompt({ sessionId }) {
      await client.sessionUpdate({
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: sessions.get(sessionId).model },
        },
      });
      return { stopReason: "end_turn" };
    },
    async cancel() {},
  }),
  ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)),
);
void connection;
