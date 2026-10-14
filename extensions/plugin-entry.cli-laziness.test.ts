import { expect, it, vi } from "vitest";
import memoryWikiPlugin from "./memory-wiki/index.js";
import policyPlugin from "./policy/index.js";
import qaLabPlugin from "./qa-lab/index.js";
import voiceCallPlugin from "./voice-call/index.js";

vi.mock("./memory-wiki/src/cli.js", () => {
  throw new Error("memory-wiki CLI eagerly imported");
});
vi.mock("./policy/src/cli.js", () => {
  throw new Error("policy CLI eagerly imported");
});
vi.mock("./qa-lab/src/cli.js", () => {
  throw new Error("qa-lab CLI eagerly imported");
});
vi.mock("./voice-call/src/cli.js", () => {
  throw new Error("voice-call CLI eagerly imported");
});

it.each([
  { id: "memory-wiki", plugin: memoryWikiPlugin },
  { id: "policy", plugin: policyPlugin },
  { id: "qa-lab", plugin: qaLabPlugin },
  { id: "voice-call", plugin: voiceCallPlugin },
])("imports $id without evaluating its CLI", ({ id, plugin }) => {
  expect(plugin.id).toBe(id);
});
