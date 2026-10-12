#!/usr/bin/env node
// Synthetic ACP peer shaped like Cursor's `agent acp`: it advertises only `mode` and a
// `category: "model"` select whose values are opaque parameterized IDs, and rejects any
// value it did not advertise with -32602, as Cursor does.
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
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
let availableModelIds = catalog.availableModelIds;
const sessionPath = (sessionId) => path.join(process.cwd(), `catalog-${sessionId}.json`);
const save = (sessionId, state) => fs.writeFileSync(sessionPath(sessionId), JSON.stringify(state));
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
    options: availableModelIds.map((value) => ({ value, name: value })),
  },
];
const connection = new AgentSideConnection(
  (client) => ({
    async initialize() {
      return {
        protocolVersion: PROTOCOL_VERSION,
        agentCapabilities: { loadSession: true },
        authMethods: [],
      };
    },
    async newSession() {
      const sessionId = randomUUID();
      const state = { model: catalog.currentModelId, history: [] };
      sessions.set(sessionId, state);
      save(sessionId, state);
      return { sessionId, configOptions: configOptions(state) };
    },
    async loadSession({ sessionId }) {
      const state = JSON.parse(fs.readFileSync(sessionPath(sessionId), "utf8"));
      sessions.set(sessionId, state);
      availableModelIds = [...catalog.availableModelIds, "composer-2.5[fast=false]"];
      return { configOptions: configOptions(state) };
    },
    async setSessionConfigOption({ sessionId, configId, value }) {
      const state = sessions.get(sessionId);
      if (configId !== "model" || !availableModelIds.includes(value)) {
        throw RequestError.invalidParams(undefined, `unsupported ${configId} value`);
      }
      if (catalog.unselectableModelIds.includes(value)) {
        // Advertised but not selectable for this account (for example a plan limit).
        throw RequestError.internalError(undefined, `${value} is not available on this plan`);
      }
      state.model = value;
      save(sessionId, state);
      return { configOptions: configOptions(state) };
    },
    async prompt({ sessionId, prompt }) {
      const state = sessions.get(sessionId);
      state.history.push(...prompt.filter((part) => part.type === "text").map((part) => part.text));
      save(sessionId, state);
      await client.sessionUpdate({
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: JSON.stringify(state) },
        },
      });
      return { stopReason: "end_turn" };
    },
    async cancel() {},
  }),
  ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)),
);
void connection;
