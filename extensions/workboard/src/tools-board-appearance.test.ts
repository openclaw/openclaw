import { fileURLToPath } from "node:url";
import { expectDefined } from "@openclaw/normalization-core";
import { validateToolArguments } from "openclaw/plugin-sdk/llm";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "../api.js";
import plugin from "../index.js";
import { WorkboardStore } from "./store.js";
import { createWorkboardSqliteTestStore } from "./test/sqlite-store.js";

function createRegisteredBoardTool() {
  const store = createWorkboardSqliteTestStore();
  using openStore = vi.spyOn(WorkboardStore, "openSqlite");
  openStore.mockReturnValueOnce(store);
  const registerTool = vi.fn<OpenClawPluginApi["registerTool"]>();
  plugin.register(
    createTestPluginApi({
      runtimeSource: fileURLToPath(new URL("../index.ts", import.meta.url)),
      runtime: createPluginRuntimeMock({
        sandbox: {
          resolveWorkspaceAuthority: vi.fn<
            OpenClawPluginApi["runtime"]["sandbox"]["resolveWorkspaceAuthority"]
          >(() => ({ sandboxed: false, workspaceAccess: "rw" })),
        },
      }),
      registerTool,
    }),
  );
  const [factory] = expectDefined(
    registerTool.mock.calls.find(([, registration]) =>
      registration?.names?.includes("workboard_board_create"),
    ),
    "Board tool factory",
  );
  if (typeof factory !== "function") {
    throw new Error("Expected the registered Workboard card tool factory.");
  }
  const tools = factory({ agentId: "main" });
  if (!Array.isArray(tools)) {
    throw new Error("Expected Workboard tools from the registered factory.");
  }
  const tool = expectDefined(
    tools.find((entry) => entry.name === "workboard_board_create"),
    "Board create tool",
  );
  const validate = (input: Record<string, unknown>) =>
    validateToolArguments(tool, {
      type: "toolCall",
      id: "board-appearance",
      name: tool.name,
      arguments: input,
    });
  return {
    // Match the agent loop: rejected arguments must never reach execute.
    update: (input: Record<string, unknown>) => tool.execute("board-appearance", validate(input)),
    read: async (id: string) =>
      expectDefined(
        (await store.listBoards()).boards.find((board) => board.id === id),
        id,
      ),
  };
}

const initialAppearance = { name: "Planning", icon: "rocket", color: "blue" };

describe("registered Workboard board appearance tool", () => {
  it.each([
    { clearAppearance: ["icon"], icon: undefined, color: "blue" },
    { clearAppearance: ["color"], icon: "rocket", color: undefined },
    { clearAppearance: ["icon", "color"], icon: undefined, color: undefined },
    { clearAppearance: "icon", icon: undefined, color: "blue" },
  ])(
    "clears $clearAppearance through validated tool calls",
    async ({ clearAppearance, icon, color }) => {
      const tool = createRegisteredBoardTool();
      const id = "planning";
      await tool.update({ id, ...initialAppearance });
      await tool.update({ id, clearAppearance });

      const board = await tool.read(id);
      expect(board.name).toBe(initialAppearance.name);
      expect(board.icon).toBe(icon);
      expect(board.color).toBe(color);
    },
  );

  it("preserves appearance when fields are omitted or empty", async () => {
    const tool = createRegisteredBoardTool();
    for (const [id, patch] of [
      ["omitted", {}],
      ["empty-values", { icon: "", color: "" }],
    ] as const) {
      await tool.update({ id, ...initialAppearance });
      await tool.update({ id, ...patch });
      expect(await tool.read(id)).toMatchObject({ id, ...initialAppearance });
    }
  });

  it("preserves appearance when the clear list is empty", async () => {
    const tool = createRegisteredBoardTool();
    const id = "empty-clear-list";
    await tool.update({ id, ...initialAppearance });
    await tool.update({ id, clearAppearance: [] });
    expect(await tool.read(id)).toMatchObject({ id, ...initialAppearance });
  });

  it("rejects invalid clear fields and types before executing a board update", async () => {
    const tool = createRegisteredBoardTool();
    const id = "invalid-clear";
    await tool.update({ id, ...initialAppearance });
    for (const clearAppearance of [["name"], ["icon", "name"], "name", null, {}]) {
      expect(() => tool.update({ id, clearAppearance })).toThrow(/clearAppearance/);
    }
    expect(await tool.read(id)).toMatchObject({ id, ...initialAppearance });
  });
});
