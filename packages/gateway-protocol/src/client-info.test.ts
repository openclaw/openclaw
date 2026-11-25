import { expect, it } from "vitest";
import { normalizeGatewayClientId, normalizeGatewayClientMode } from "./client-info.js";

it.each([
  { raw: " CLI ", id: "cli", mode: "cli" },
  { raw: " OPENCLAW-CONTROL-UI ", id: "openclaw-control-ui", mode: undefined },
  { raw: " BACKEND ", id: undefined, mode: "backend" },
  { raw: "unknown", id: undefined, mode: undefined },
  { raw: "", id: undefined, mode: undefined },
  { raw: " \t ", id: undefined, mode: undefined },
  { raw: null, id: undefined, mode: undefined },
  { raw: undefined, id: undefined, mode: undefined },
])("normalizes client identity and mode independently from $raw", ({ raw, id, mode }) => {
  expect(normalizeGatewayClientId(raw)).toBe(id);
  expect(normalizeGatewayClientMode(raw)).toBe(mode);
});
