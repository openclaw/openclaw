import { describe, expect, it } from "vitest";
import { createPlanGenerator, type ToolDefinition } from "../plan-generator.js";

const tools: ToolDefinition[] = [
  { name: "web_fetch", description: "Fetch a URL" },
  { name: "message.send", description: "Send a message" },
];

describe("camel/plan-generator", () => {
  it("parses JSON execution plans", async () => {
    const generatePlan = createPlanGenerator(async () =>
      JSON.stringify({
        description: "fetch and send",
        steps: [
          {
            id: "s1",
            tool: "web_fetch",
            args: { url: "https://example.com" },
            assignTo: "page",
          },
          {
            id: "s2",
            tool: "message.send",
            args: { body: { ref: "page", extract: "summarize page" } },
          },
        ],
      }),
    );

    const plan = await generatePlan("summarize and send", tools, "test-model");
    expect(plan.description).toBe("fetch and send");
    expect(plan.steps).toHaveLength(2);
  });

  it("rejects malformed plans", async () => {
    const generatePlan = createPlanGenerator(async () => "{ bad json");
    await expect(generatePlan("x", tools, "test-model")).rejects.toThrow(
      /Invalid execution plan: .*Raw \(truncated\): \{ bad json/,
    );
  });

  it("accepts non-string JSON argument values", async () => {
    const generatePlan = createPlanGenerator(async () =>
      JSON.stringify({
        description: "mixed args",
        steps: [
          {
            id: "s1",
            tool: "web_fetch",
            args: {
              retries: 3,
              includeCache: false,
              headers: { accept: "application/json" },
              tags: ["news", "today"],
              optional: null,
            },
          },
        ],
      }),
    );

    const plan = await generatePlan("fetch", tools, "test-model");
    expect(plan.steps[0]?.args.retries).toBe(3);
    expect(plan.steps[0]?.args.includeCache).toBe(false);
    expect(plan.steps[0]?.args.tags).toEqual(["news", "today"]);
    expect(plan.steps[0]?.args.optional).toBeNull();
    expect(plan.steps[0]?.args.headers).toEqual({ accept: "application/json" });
  });
});
