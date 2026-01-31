import { describe, it, expect, vi } from "vitest";
import { createOpenClawReadTool } from "./pi-tools.read";
import type { AnyAgentTool } from "./pi-tools.types";

describe("createOpenClawReadTool", () => {
    it("should catch 'beyond end of file' errors and return a friendly error result", async () => {
        const mockBaseTool: AnyAgentTool = {
            name: "read",
            description: "read file",
            schema: { properties: {} },
            execute: vi.fn().mockRejectedValue(new Error("Offset 800 is beyond end of file (777 lines total)")),
        };

        const tool = createOpenClawReadTool(mockBaseTool);

        // We need to pass valid params to pass validation if any, but the mock throws anyway.
        // However, createOpenClawReadTool calls normalizeToolParams and assertRequiredParams first.
        // assertRequiredParams requires 'path'.
        const params = { path: "/tmp/foo.ts" };

        const result = await tool.execute("call-1", params);

        expect(result).toEqual({
            toolCallId: "call-1",
            toolName: "read",
            content: [
                {
                    type: "text",
                    text: expect.stringContaining("Observation: Error: Offset 800 is beyond end of file"),
                }
            ],
            isError: false,
            details: { text: expect.stringContaining("Offset 800 is beyond end of file") },
        });

        expect(mockBaseTool.execute).toHaveBeenCalled();
    });

    it("should rethrow other errors", async () => {
        const mockBaseTool: AnyAgentTool = {
            name: "read",
            description: "read file",
            schema: { properties: {} },
            execute: vi.fn().mockRejectedValue(new Error("Something else went wrong")),
        };

        const tool = createOpenClawReadTool(mockBaseTool);
        const params = { path: "/tmp/foo.ts" };

        await expect(tool.execute("call-2", params)).rejects.toThrow("Something else went wrong");
    });
});
