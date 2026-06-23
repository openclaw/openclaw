import { asString } from "../../client/envelope.js";
import type { ScheduledTask } from "../types.js";
import type { ScheduleActionType } from "./types.js";

const MAX_INSTRUCTION = 2000;
const RUN_TIMEOUT_MS = 300_000; // 5 min, matches the chat pipeline's subagent wait

/** Last assistant turn's text — content is a string in simple sessions, an array of
 * content blocks in tool-using ones; extract text so delivery always gets a string. */
function lastAssistantText(messages: unknown[]): string {
  for (const msg of [...messages].reverse()) {
    const m = msg as { role?: string; content?: unknown };
    if (m.role !== "assistant") {
      continue;
    }
    const c = m.content;
    if (typeof c === "string" && c.trim()) {
      return c.trim();
    }
    if (Array.isArray(c)) {
      const text = c
        .map((b) => (b as { text?: string }).text ?? "")
        .join("")
        .trim();
      if (text) {
        return text;
      }
    }
  }
  return "";
}

/**
 * 通用智能体任务: the universal scheduled action. When it fires, the user's agent runs
 * a natural-language instruction in a derived, isolated session (sessionKey + ":sched"
 * so a scheduled turn never collides with a live chat turn) and the assistant's reply
 * is delivered through the same Notifier transports (Mercure / history / email).
 *
 * This covers reminders, greetings, scheduled pushes, and any "智脑"-style task — the
 * scheduled agent has the full chat toolset, so it can call report_create / opinion_*
 * etc. and report the result itself, with no per-action runner needed.
 */
export const agentPromptAction: ScheduleActionType = {
  name: "agent_prompt",
  tool: "agent_prompt",
  label: "智能体任务",
  summary:
    "通用智能体任务：到点让助手执行一段自然语言指令，并把助手的回复发给用户。" +
    "用于提醒、打招呼、定时推送，或任何需要助手思考/调用其它工具才能完成的任务。" +
    "params: { instruction: string 要执行的指令，例如 '生成今天的舆情摘要并发给用户' }。",
  validate(params) {
    const instruction = asString(params.instruction)?.trim();
    if (!instruction) {
      return { ok: false, error: "agent_prompt 需要 instruction(要执行的自然语言指令)。" };
    }
    return { ok: true, params: { instruction: instruction.slice(0, MAX_INSTRUCTION) } };
  },
  makeRunner(deps) {
    return async (task: ScheduledTask) => {
      const { subagent, deliver, logger } = deps;
      if (!subagent) {
        return { ok: false, note: "subagent runtime unavailable" };
      }
      const instruction = asString(task.action.params.instruction);
      if (!instruction) {
        return { ok: false, note: "missing instruction" };
      }
      // Derived session: keeps scheduled turns off the user's live chat session.
      const sessionKey = `${task.sessionKey}:sched`;
      const firedAt = Date.now();
      try {
        const { runId } = await subagent.run({
          sessionKey,
          message: `[scheduled-task][userId:${task.uid}] ${instruction}`,
          deliver: false,
        });
        const wait = await subagent.waitForRun({ runId, timeoutMs: RUN_TIMEOUT_MS });
        if (wait.status !== "ok") {
          return { ok: false, note: `subagent ${wait.status}: ${wait.error ?? ""}` };
        }
        const { messages } = await subagent.getSessionMessages({ sessionKey, limit: 5 });
        const text = lastAssistantText(messages ?? []);
        if (!text) {
          return { ok: false, note: "empty agent response" };
        }
        const ok = await deliver(
          {
            id: `schedule:${task.id}:${firedAt}`, // dedupe per fire
            uid: task.uid,
            category: "scheduled",
            level: "info",
            title: task.title || "定时任务",
            body: text,
            ts: firedAt,
          },
          { mercureTopic: task.mercureTopic, sessionKey: task.sessionKey },
        );
        if (!ok) {
          logger.warn(`[LEADING_V2_SCHED] agent_prompt produced a reply but no transport accepted it (task ${task.id})`);
        }
        return { ok: true, note: text.slice(0, 80) };
      } catch (error) {
        return { ok: false, note: String(error) };
      }
    };
  },
};
