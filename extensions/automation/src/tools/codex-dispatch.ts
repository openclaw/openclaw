import { Type } from "typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";

export function createCodexDispatchTool(api: OpenClawPluginApi) {
  return {
    name: "automation_codex_execute",
    label: "Codex Execute",
    description:
      "Dispatch a coding task to the Codex CLI agent. Use this when the task requires " +
      "code generation, refactoring, bug fixing, or any file modification. " +
      "Codex will execute in the project workspace and return results.",
    parameters: Type.Object({
      instruction: Type.String({
        description: "The coding instruction for Codex (e.g., 'refactor auth module to use JWT')",
      }),
      files: Type.Optional(
        Type.Array(Type.String(), { description: "Specific files to focus on" }),
      ),
      timeoutMs: Type.Optional(
        Type.Number({ description: "Timeout in milliseconds. Default: 120000 (2 min)", default: 120_000 }),
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
        throw new Error("instruction is required");
      }

      const files = Array.isArray(params.files)
        ? params.files.filter((f): f is string => typeof f === "string")
        : undefined;
      const timeoutMs = typeof params.timeoutMs === "number" ? params.timeoutMs : 120_000;

      const filesContext = files?.length ? `\nFocus on files: ${files.join(", ")}` : "";
      const fullPrompt = `${instruction}${filesContext}`;

      const sessionKey = `automation-codex-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

      const { runId } = await api.runtime.subagent.run({
        sessionKey,
        message: fullPrompt,
        provider: "codex",
        extraSystemPrompt:
          "You are a coding execution agent. Complete the task efficiently. " +
          "Return a clear summary of what you changed.",
      });

      const waitResult = await api.runtime.subagent.waitForRun({ runId, timeoutMs });

      if (waitResult.status === "timeout") {
        return [
          {
            type: "text" as const,
            text: `## Codex Execution\n\n⏰ Timeout after ${timeoutMs / 1000}s. Run ID: ${runId}\nThe task may still be running. Check back later.`,
          },
        ];
      }

      if (waitResult.status === "error") {
        return [
          {
            type: "text" as const,
            text: `## Codex Execution Error\n\n❌ ${waitResult.error ?? "Unknown error"}`,
          },
        ];
      }

      const { messages } = await api.runtime.subagent.getSessionMessages({
        sessionKey,
        limit: 10,
      });

      const outputText = messages
        .map((msg: any) => {
          if (typeof msg === "string") return msg;
          if (msg?.text) return msg.text;
          if (msg?.content) return typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
          return JSON.stringify(msg);
        })
        .join("\n\n");

      await api.runtime.subagent.deleteSession({ sessionKey });

      return [
        {
          type: "text" as const,
          text: `## Codex Execution Result\n\n✅ Completed\n\n${outputText || "(no output)"}`,
        },
      ];
    },
  };
}
