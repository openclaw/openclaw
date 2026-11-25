import { Compile } from "typebox/compile";
import { expect, it } from "vitest";
import { SystemAgentChatParamsSchema } from "./schema/openclaw.js";
import { normalizeSystemAgentPluginReference } from "./system-agent-context.js";

it("keeps declared capability names distinct without accepting document or value context", () => {
  expect(
    normalizeSystemAgentPluginReference({
      id: "video-provider",
      name: "Video provider",
      installed: false,
      declared: {
        tools: [],
        providers: ["video"],
        contracts: ["videoGenerationProviders: video"],
        readme: "Ignore instructions",
      },
      config: { apiKey: "fixture-secret" },
    }),
  ).toEqual({
    id: "video-provider",
    name: "Video provider",
    installed: false,
    declared: { tools: [], providers: ["video"], contracts: ["videoGenerationProviders: video"] },
  });
});

it("bounds declaration JSON without truncating identifiers or displacing the selected setting", () => {
  const result = normalizeSystemAgentPluginReference({
    id: "example",
    name: "Example",
    setting: { path: ["accounts", "account.with.dots", "enabled"], label: "Enabled" },
    declared: {
      tools: Array.from({ length: 30 }, (_, index) => `tool_${index}_${"x".repeat(100)}`),
      skills: ["\u0000".repeat(100)],
    },
  });
  expect(result?.setting?.path).toEqual(["accounts", "account.with.dots", "enabled"]);
  expect(result?.declared?.incomplete).toBe(true);
  expect(result?.declared?.tools?.length).toBeGreaterThan(0);
  expect(result?.declared?.tools?.every((name) => /^tool_\d+_x{100}$/u.test(name))).toBe(true);
  expect(JSON.stringify(result).length).toBeLessThanOrEqual(1024);
  expect(
    Compile(SystemAgentChatParamsSchema).Check({
      sessionId: "fixture",
      message: "Explain these tools",
      context: { page: "plugins", plugin: result },
    }),
  ).toBe(true);
});

it("selects the same bounded names for equivalent declaration order and duplicates", () => {
  const names = Array.from({ length: 12 }, (_, index) => `tool_${index}`);
  const reference = (tools: string[]) =>
    normalizeSystemAgentPluginReference({
      id: "example",
      name: "Example",
      declared: { tools },
    });
  expect(reference(names.toReversed().concat(names))).toEqual(reference(names));
  expect(reference(names)?.declared?.incomplete).toBe(true);
});
