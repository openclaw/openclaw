import { randomUUID } from "node:crypto";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { Type } from "typebox";

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  details: unknown;
};

function textResult(text: string, details: unknown): ToolResult {
  return {
    content: [{ type: "text", text }],
    details,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stringifyUnknown(value: unknown): string {
  const serialized = JSON.stringify(value);
  return serialized ?? String(value);
}

function codexMessageToText(message: unknown): string {
  if (typeof message === "string") {
    return message;
  }

  if (isRecord(message)) {
    const text = message.text;
    if (typeof text === "string") {
      return text;
    }

    const content = message.content;
    if (typeof content === "string") {
      return content;
    }
    if (content !== undefined) {
      return stringifyUnknown(content);
    }
  }

  return stringifyUnknown(message);
}

function buildCodexDispatchError(params: {
  errorCode: "CODEX_INPUT_INVALID";
  nextAction: string;
  detail: string;
}): string {
  return (
    `回覆狀態：FAILED\n` +
    `error_code=${params.errorCode}\n` +
    `next_action=${params.nextAction}\n` +
    `detail=${params.detail}`
  );
}

function buildCodexStatusText(params: {
  status: "ok" | "timeout" | "error";
  runId: string;
  timeoutMs?: number;
  message?: string;
  outputText?: string;
}): string {
  if (params.status === "timeout") {
    return (
      `回覆狀態：FAILED\n` +
      `error_code=TIMEOUT\n` +
      `next_action=RETRY_OR_CHECK_STATUS\n` +
      `說明：執行逾時（${Math.floor((params.timeoutMs ?? 0) / 1000)} 秒）。\n` +
      `run_id=${params.runId}\n` +
      `detail=${params.message ?? "任務可能仍在背景執行。"}`
    );
  }

  if (params.status === "error") {
    return (
      `回覆狀態：FAILED\n` +
      `error_code=EXECUTION_ERROR\n` +
      `next_action=CHECK_INPUT_OR_RETRY\n` +
      `run_id=${params.runId}\n` +
      `detail=${params.message ?? "未知錯誤"}`
    );
  }

  return (
    `回覆狀態：SUCCESS\n` +
    `error_code=NONE\n` +
    `next_action=NEXT_TASK\n` +
    `run_id=${params.runId}\n\n` +
    (params.outputText?.trim() || "(無輸出)")
  );
}

export function createCodexDispatchTool(api: OpenClawPluginApi) {
  return {
    name: "automation_codex_execute",
    label: "Codex 執行器",
    description:
      "將程式任務分派給 Codex CLI agent 執行。適用於寫碼、重構、修 bug、檔案修改等任務。" +
      "Codex 會在專案工作目錄執行並回傳結果。",
    parameters: Type.Object({
      instruction: Type.String({
        description: "給 Codex 的執行指令（例如：重構 auth module 改用 JWT）",
      }),
      files: Type.Optional(Type.Array(Type.String(), { description: "指定優先處理檔案清單" })),
      timeoutMs: Type.Optional(
        Type.Number({ description: "逾時毫秒數，預設 120000（2 分鐘）", default: 120_000 }),
      ),
    }),

    async execute(
      _id: string,
      params: {
        instruction?: unknown;
        files?: unknown;
        timeoutMs?: unknown;
      },
    ) {
      const instruction = typeof params.instruction === "string" ? params.instruction.trim() : "";
      if (!instruction) {
        throw new Error(
          buildCodexDispatchError({
            errorCode: "CODEX_INPUT_INVALID",
            nextAction: "PROVIDE_INSTRUCTION",
            detail: "缺少 instruction 參數。",
          }),
        );
      }

      const files = Array.isArray(params.files)
        ? params.files.filter((f): f is string => typeof f === "string")
        : undefined;
      const timeoutMs = typeof params.timeoutMs === "number" ? params.timeoutMs : 120_000;

      const filesContext = files?.length ? `\n優先處理檔案：${files.join(", ")}` : "";
      const fullPrompt = `${instruction}${filesContext}`;

      const sessionKey = `automation-codex-${randomUUID()}`;

      const { runId } = await api.runtime.subagent.run({
        sessionKey,
        message: fullPrompt,
        provider: "codex",
        extraSystemPrompt: "你是程式執行代理。請高效率完成任務，並清楚摘要實際修改內容。",
      });

      const waitResult = await api.runtime.subagent.waitForRun({ runId, timeoutMs });

      if (waitResult.status === "timeout") {
        return textResult(
          buildCodexStatusText({
            status: "timeout",
            runId,
            timeoutMs,
            message: "任務可能仍在背景執行，請稍後查詢。",
          }),
          { status: "timeout", runId, timeoutMs },
        );
      }

      if (waitResult.status === "error") {
        const errText = waitResult.error ?? "未知錯誤";
        return textResult(
          buildCodexStatusText({
            status: "error",
            runId,
            message: errText,
          }),
          { status: "error", runId, error: errText },
        );
      }

      const { messages } = await api.runtime.subagent.getSessionMessages({
        sessionKey,
        limit: 10,
      });

      const outputText = messages
        .map((message: unknown) => codexMessageToText(message))
        .join("\n\n");

      await api.runtime.subagent.deleteSession({ sessionKey });

      return textResult(
        buildCodexStatusText({
          status: "ok",
          runId,
          outputText,
        }),
        { status: "ok", runId },
      );
    },
  };
}
