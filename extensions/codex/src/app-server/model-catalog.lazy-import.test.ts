import { expect, it, vi } from "vitest";

vi.mock("openclaw/plugin-sdk/agent-runtime", () => {
  throw new Error("Native catalog import loaded host credential runtime");
});

it("imports the actual native model catalog without loading host credential runtime", async () => {
  const { createCodexAppServerModelCatalog } = await import("./model-catalog.js");
  const catalog = createCodexAppServerModelCatalog("codex");
  try {
    expect(
      catalog.read(
        {
          config: {},
          agentId: "synthetic-agent",
          agentDir: "/synthetic/agent",
          workspaceDir: "/synthetic/workspace",
          provider: "openai",
          modelId: "synthetic-model",
        },
        undefined,
      ),
    ).toBeUndefined();
  } finally {
    catalog.dispose();
  }
});
