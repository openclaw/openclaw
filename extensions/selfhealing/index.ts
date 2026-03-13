import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { readMemory, appendMemory } from "./src/memory.js";
import {
  parseExecCommand,
  createSubagentEntry,
  detectClaim,
  verifyAll,
  type TrackedProcess,
} from "./src/verifier.js";

type PluginConfig = {
  enabled?: boolean;
  maxLessons?: number;
};

// Session lessons loaded at session_start
const sessionCache = new Map<string, { text: string; lessons: string[] }>();

// All background processes tracked during the session via after_tool_call
const processCache = new Map<string, TrackedProcess[]>();

// Corrections to inject into the next turn (from failed verifications)
const correctionCache = new Map<string, string>();

// Track active delayed checks so they can be cancelled on session end
const delayedChecks = new Map<string, ReturnType<typeof setTimeout>[]>();

function resolveKey(ctx: { sessionId?: string; sessionKey?: string }): string {
  return ctx.sessionId ?? ctx.sessionKey ?? "default";
}

export default function register(api: OpenClawPluginApi) {
  const cfg = (api.pluginConfig ?? {}) as PluginConfig;
  if (cfg.enabled === false) return;

  api.logger.info("[selfhealing] REGISTERING HOOKS");

  const workspaceDir = api.config?.agents?.defaults?.workspace ?? process.cwd();
  const maxLessons = cfg.maxLessons ?? 10;

  // Load past lessons when session starts
  api.on("session_start", async (_event, ctx) => {
    const key = resolveKey(ctx);
    const entries = await readMemory(workspaceDir);
    if (entries.length === 0) return;
    const recent = entries.slice(-maxLessons);
    const lessons = recent.map((e) => e.lesson);
    const text = `[Past lessons from previous sessions]\n${lessons.map((l) => `- ${l}`).join("\n")}`;
    sessionCache.set(key, { text, lessons });
  });

  // Prepend past lessons + any corrections from failed verifications
  api.on("before_prompt_build", (_event, ctx) => {
    const key = resolveKey(ctx);
    const parts: string[] = [];

    const cached = sessionCache.get(key);
    if (cached) parts.push(cached.text);

    const correction = correctionCache.get(key);
    if (correction) {
      parts.push(
        `[Self-heal: your last response was blocked because verification failed]\n${correction}\nCheck the actual state before claiming success again.`,
      );
      correctionCache.delete(key);
    }

    if (parts.length === 0) return;
    return { prependContext: parts.join("\n\n") };
  });

  // Track every background process or subagent the agent launches
  api.on("after_tool_call", (_event, ctx) => {
    const key = resolveKey(ctx);

    if (_event.toolName === "exec") {
      const tracked = parseExecCommand(_event.params);
      if (!tracked) return;
      const existing = processCache.get(key) ?? [];
      existing.push(tracked);
      processCache.set(key, existing);

      // Delayed re-check: after 15 seconds, verify the process is still alive
      const timer = setTimeout(() => {
        // Only fire if session is still active (key still in processCache)
        if (!processCache.has(key)) return;
        const result = verifyAll([tracked]);
        if (!result.passed) {
          correctionCache.set(key, `Delayed check: ${result.reason}`);
        }
      }, 15_000);

      const timers = delayedChecks.get(key) ?? [];
      timers.push(timer);
      delayedChecks.set(key, timers);
    }

    if (_event.toolName === "sessions_spawn") {
      const label = typeof _event.params.label === "string" ? _event.params.label : "subagent";
      const existing = processCache.get(key) ?? [];
      existing.push(createSubagentEntry(label));
      processCache.set(key, existing);
    }
  });

  // Block messages that contain unverified success claims
  // Everything is sync (regex + execFileSync) so this works in the sync-only hook
  api.on("before_message_write", (event, ctx) => {
    const msg = event.message;
    if (msg.role !== "assistant") return;

    // Extract text from message content
    const content = msg.content;
    const text = Array.isArray(content)
      ? content
          .filter((c: Record<string, unknown>) => c.type === "text")
          .map((c: Record<string, unknown>) => String(c.text ?? ""))
          .join(" ")
      : typeof content === "string"
        ? content
        : "";

    if (!detectClaim(text)) return;

    const key = resolveKey(ctx);
    api.logger.info(`[selfhealing] claim detected in before_message_write. key=${key}`);

    const tracked = processCache.get(key) ?? [];
    const execProcesses = tracked.filter((t) => t.kind === "exec");

    if (tracked.length === 0) {
      correctionCache.set(
        key,
        "You claimed success but no background processes or subagents were tracked. Verify the task is actually running before claiming completion.",
      );
      api.logger.info("[selfhealing] BLOCKED — no processes tracked");
      return { block: true };
    }

    if (execProcesses.length === 0) return;

    const result = verifyAll(tracked);
    api.logger.info(`[selfhealing] verifyAll: passed=${result.passed} reason=${result.reason}`);
    if (!result.passed) {
      correctionCache.set(key, result.reason);
      api.logger.info("[selfhealing] BLOCKED — verification failed");
      return { block: true };
    }
  });

  // Write lesson to memory when session ends — verify before claiming success
  api.on("agent_end", async (event, ctx) => {
    const key = resolveKey(ctx);
    const tracked = processCache.get(key) ?? [];
    const summary = tracked.map((p) => p.command.slice(0, 100)).join(" | ");

    // Cancel any pending delayed checks for this session
    const timers = delayedChecks.get(key) ?? [];
    for (const t of timers) clearTimeout(t);
    delayedChecks.delete(key);

    if (event.success && tracked.length > 0) {
      const verification = verifyAll(tracked);
      if (verification.passed) {
        await appendMemory(workspaceDir, {
          timestamp: new Date().toISOString(),
          lesson: `Session succeeded and verified. Working commands: ${summary}`,
          source: "session_success",
        });
      } else {
        await appendMemory(workspaceDir, {
          timestamp: new Date().toISOString(),
          lesson: `Session claimed success but verification failed: ${verification.reason}. Commands attempted: ${summary}`,
          source: "session_failure",
        });
      }
    } else if (event.error) {
      await appendMemory(workspaceDir, {
        timestamp: new Date().toISOString(),
        lesson: `Session failed: ${event.error.slice(0, 150)}. Commands attempted: ${summary}`,
        source: "session_failure",
      });
    }

    // Clean up all session state
    sessionCache.delete(key);
    processCache.delete(key);
    correctionCache.delete(key);
  });
}
