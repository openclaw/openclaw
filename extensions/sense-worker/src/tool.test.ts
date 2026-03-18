import { describe, expect, it, vi } from "vitest";
import { createSenseWorkerTool } from "./tool.js";

vi.mock("./client.js", () => ({
  checkSenseHealth: vi.fn(async () => ({
    ok: true,
    status: 200,
    url: "http://sense/health",
    body: { status: "ok" },
  })),
  callSense: vi.fn(async () => ({
    ok: true,
    status: 200,
    url: "http://sense/execute",
    body: { status: "ok", result: "Sense summary" },
  })),
}));

function fakeApi() {
  return {
    pluginConfig: { baseUrl: "http://sense:8787", timeoutMs: 6000 },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  } as any;
}

describe("sense worker tool", () => {
  it("returns health details", async () => {
    const tool = createSenseWorkerTool(fakeApi());
    const result = await tool.execute("id", { action: "health" });
    expect((result as any).details.status).toBe(200);
    expect((result as any).content[0].text).toContain('"status": "ok"');
  });

  it("returns summarized execute text", async () => {
    const tool = createSenseWorkerTool(fakeApi());
    const result = await tool.execute("id", {
      action: "execute",
      task: "summarize",
      input: "hello",
      params: { mode: "short" },
    });
    expect((result as any).content[0].text).toContain("Sense summary");
    expect((result as any).details.url).toContain("/execute");
  });

  it("passes through generate_draft task", async () => {
    const tool = createSenseWorkerTool(fakeApi());
    const result = await tool.execute("id", {
      action: "execute",
      task: "generate_draft",
      input: "Write a short follow-up note.",
      params: { tone: "polite" },
    });
    expect((result as any).content[0].text).toContain("Sense summary");
    expect((result as any).details.status).toBe(200);
  });
});
