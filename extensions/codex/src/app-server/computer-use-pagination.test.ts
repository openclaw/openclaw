import { describe, expect, it } from "vitest";
import { readCodexComputerUseStatus } from "./computer-use.js";
import { createComputerUseRequest } from "./computer-use.test-support.js";

describe("Codex Computer Use MCP discovery", () => {
  it.each([0, 1])(
    "finds the server after %i preceding pages without fetching past it",
    async (precedingPages) => {
      const request = createComputerUseRequest({
        installed: true,
        mcpStatusPages: [
          ...Array.from({ length: precedingPages }, () => ({
            data: [],
            nextCursor: "computer-use-page",
          })),
          {
            data: [
              {
                name: "computer-use",
                tools: { list_apps: { name: "list_apps", inputSchema: { type: "object" } } },
                resources: [],
                resourceTemplates: [],
                authStatus: "unsupported",
              },
            ],
            nextCursor: "unavailable-page",
          },
        ],
      });

      const status = await readCodexComputerUseStatus({
        pluginConfig: { computerUse: { enabled: true, marketplaceName: "desktop-tools" } },
        request,
      });

      expect(status).toMatchObject({
        ready: true,
        mcpServerAvailable: true,
        tools: ["list_apps"],
        liveTest: { status: "passed" },
      });
    },
  );
});
