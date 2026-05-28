import { describe, expect, it, vi } from "vitest";
import { createCodexDispatchTool } from "./codex-dispatch.js";

function buildApi(params?: {
  waitStatus?: "ok" | "timeout" | "error";
  waitError?: string;
  messages?: Array<unknown>;
}) {
  const run = vi.fn(async () => ({ runId: "run-123" }));
  const waitForRun = vi.fn(async () => {
    if (params?.waitStatus === "timeout") {
      return { status: "timeout" as const };
    }
    if (params?.waitStatus === "error") {
      return { status: "error" as const, error: params.waitError ?? "boom" };
    }
    return { status: "ok" as const };
  });
  const getSessionMessages = vi.fn(async () => ({
    messages: params?.messages ?? [{ text: "done" }],
  }));
  const deleteSession = vi.fn(async () => {});

  const api = {
    runtime: {
      subagent: {
        run,
        waitForRun,
        getSessionMessages,
        deleteSession,
      },
    },
  } as any;

  return { api, run, waitForRun, getSessionMessages, deleteSession };
}

describe("automation codex dispatch tool", () => {
  it("exposes zh-tw metadata", () => {
    const { api } = buildApi();
    const tool = createCodexDispatchTool(api);
    expect(tool.label).toBe("Codex 執行器");
    expect(tool.description).toContain("分派給 Codex");
  });

  it("returns fixed-format error when instruction is missing", async () => {
    const { api } = buildApi();
    const tool = createCodexDispatchTool(api);
    await expect(tool.execute("id", {})).rejects.toThrow("error_code=CODEX_INPUT_INVALID");
  });

  it("returns timeout fixed-format text", async () => {
    const { api } = buildApi({ waitStatus: "timeout" });
    const tool = createCodexDispatchTool(api);
    const result = await tool.execute("id", { instruction: "do it", timeoutMs: 15000 });
    const text = result.content[0]?.text ?? "";
    expect(text).toContain("回覆狀態：FAILED");
    expect(text).toContain("error_code=TIMEOUT");
    expect(text).toContain("next_action=RETRY_OR_CHECK_STATUS");
  });

  it("returns error fixed-format text", async () => {
    const { api } = buildApi({ waitStatus: "error", waitError: "network failed" });
    const tool = createCodexDispatchTool(api);
    const result = await tool.execute("id", { instruction: "do it" });
    const text = result.content[0]?.text ?? "";
    expect(text).toContain("回覆狀態：FAILED");
    expect(text).toContain("error_code=EXECUTION_ERROR");
    expect(text).toContain("detail=network failed");
  });

  it("returns success fixed-format text and cleans up session", async () => {
    const { api, deleteSession } = buildApi({ waitStatus: "ok", messages: [{ text: "完成" }] });
    const tool = createCodexDispatchTool(api);
    const result = await tool.execute("id", { instruction: "do it" });
    const text = result.content[0]?.text ?? "";
    expect(text).toContain("回覆狀態：SUCCESS");
    expect(text).toContain("error_code=NONE");
    expect(text).toContain("完成");
    expect(deleteSession).toHaveBeenCalledTimes(1);
  });
});
