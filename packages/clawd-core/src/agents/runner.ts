import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type AgentSessionEvent,
  codingTools,
  createAgentSession,
  discoverSkills,
  SessionManager,
} from "@mariozechner/pi-coding-agent";
import type { ClawdConfig, ThinkLevel } from "../config/types.js";
import { createBashTool, createProcessTool } from "../tools/bash-tools.js";
import { resolveUserPath } from "../utils/index.js";
import {
  getOrCreateSession,
  loadSessionStore,
  resolveMainSessionKey,
  resolveStorePath,
  saveSessionStore,
  updateSessionUsage,
} from "./sessions.js";
import { applySkillEnvOverrides, loadWorkspaceSkillEntries } from "./skills.js";
import { buildAgentSystemPromptAppend } from "./system-prompt.js";
import {
  buildBootstrapContextFiles,
  ensureAgentWorkspace,
  loadWorkspaceBootstrapFiles,
} from "./workspace.js";

export type AgentRunnerParams = {
  /** The user message to process */
  message: string;
  /** Session key (defaults to main session) */
  sessionKey?: string;
  /** Configuration */
  config?: ClawdConfig;
  /** Thinking level override */
  thinkingLevel?: ThinkLevel;
  /** Callback for streaming text chunks */
  onTextChunk?: (text: string) => void;
  /** Callback for tool use events */
  onToolUse?: (name: string, input: unknown) => void;
  /** Callback for tool results */
  onToolResult?: (name: string, result: unknown) => void;
  /** Abort signal */
  signal?: AbortSignal;
};

export type AgentRunnerResult = {
  /** The final response text */
  response: string;
  /** Session ID used */
  sessionId: string;
  /** Session key used */
  sessionKey: string;
  /** Token usage */
  usage?: {
    input?: number;
    output?: number;
    total?: number;
  };
  /** Model used */
  model?: string;
};

function mapThinkingLevel(
  level?: ThinkLevel,
): "off" | "low" | "medium" | "high" {
  if (!level || level === "off") return "off";
  return level;
}

/**
 * Run the Clawd agent with a message.
 * This is the main entry point for the agent loop.
 */
export async function runClawdAgent(
  params: AgentRunnerParams,
): Promise<AgentRunnerResult> {
  const { message, config, signal, onTextChunk, onToolUse, onToolResult } =
    params;

  // Resolve workspace
  const workspaceDir = config?.agent?.workspace
    ? resolveUserPath(config.agent.workspace)
    : path.join(os.homedir(), "clawd");

  await ensureAgentWorkspace({ dir: workspaceDir, ensureBootstrapFiles: true });

  // Load workspace files (AGENTS.md, IDENTITY.md, etc.)
  const bootstrapFiles = await loadWorkspaceBootstrapFiles(workspaceDir);
  const contextFiles = buildBootstrapContextFiles(bootstrapFiles);

  // Load skills from workspace
  const skillEntries = loadWorkspaceSkillEntries(workspaceDir, { config });

  // Apply skill env overrides
  const cleanupEnv = applySkillEnvOverrides({ skills: skillEntries, config });

  try {
    // Resolve session key and sessions directory
    const sessionKey = params.sessionKey ?? resolveMainSessionKey(config);
    const storePath = resolveStorePath(config?.session?.store);
    const store = loadSessionStore(storePath);
    const sessionEntry = getOrCreateSession(store, sessionKey);

    // Sessions directory for transcripts (separate from our metadata store)
    const sessionsDir = path.dirname(storePath);
    await fs.promises.mkdir(sessionsDir, { recursive: true });

    // Create SessionManager that continues recent session or creates new one
    // This ensures conversation history persists across runs
    const sessionManager = SessionManager.continueRecent(
      workspaceDir,
      sessionsDir,
    );
    const sessionId = sessionManager.getSessionId();

    // Build custom tools (our bash tool replaces the default)
    const bashTool = createBashTool({
      backgroundMs: config?.agent?.bash?.backgroundMs,
      timeoutSec: config?.agent?.bash?.timeoutSec,
    });
    const processTool = createProcessTool();

    // Filter out the default bash tool and add ours
    const baseTools = codingTools.filter((t) => t.name !== "bash");
    const tools = [...baseTools, bashTool, processTool] as any[];

    // Discover skills using pi-coding-agent's discovery
    const skills = discoverSkills(workspaceDir);

    // Build thinking level
    const thinkingLevel = mapThinkingLevel(
      params.thinkingLevel ?? (config?.agent?.thinking as ThinkLevel),
    );

    // Build custom system prompt append
    const systemPromptAppend = buildAgentSystemPromptAppend({
      workspaceDir,
      defaultThinkLevel: thinkingLevel === "off" ? undefined : thinkingLevel,
      toolNames: tools.map((t) => t.name),
      userTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      userTime: new Date().toLocaleString(),
      runtimeInfo: {
        host: os.hostname(),
        os: `${os.type()} ${os.release()}`,
        arch: os.arch(),
        node: process.version,
      },
    });

    // Create agent session using pi-coding-agent SDK with our session manager
    const { session } = await createAgentSession({
      cwd: workspaceDir,
      tools,
      skills,
      contextFiles,
      thinkingLevel,
      sessionManager,
      systemPrompt: (defaultPrompt: string) => {
        return `${defaultPrompt}\n\n${systemPromptAppend}`;
      },
    });

    // Subscribe to events
    let responseText = "";

    const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
      if (signal?.aborted) return;

      // Handle message updates (text streaming)
      if (event.type === "message_update") {
        const evt = event as AgentSessionEvent & {
          message?: { role?: string; content?: unknown[] };
          assistantMessageEvent?: { type?: string; text?: string };
        };
        if (evt.message?.role === "assistant") {
          const assistantEvent = evt.assistantMessageEvent;
          if (
            assistantEvent?.type === "text_delta" &&
            typeof assistantEvent.text === "string"
          ) {
            onTextChunk?.(assistantEvent.text);
          }
        }
      }

      // Handle tool execution events
      if (event.type === "tool_execution_start") {
        const evt = event as AgentSessionEvent & {
          toolName?: string;
          args?: unknown;
        };
        if (evt.toolName) {
          onToolUse?.(evt.toolName, evt.args);
        }
      }

      if (event.type === "tool_execution_end") {
        const evt = event as AgentSessionEvent & {
          toolName?: string;
          result?: unknown;
        };
        if (evt.toolName) {
          onToolResult?.(evt.toolName, evt.result);
        }
      }

      // Capture final message text on message_end
      if (event.type === "message_end") {
        const evt = event as AgentSessionEvent & {
          message?: {
            role?: string;
            content?: Array<{ type: string; text?: string }>;
          };
        };
        if (
          evt.message?.role === "assistant" &&
          Array.isArray(evt.message.content)
        ) {
          const textContent = evt.message.content
            .filter((c) => c.type === "text" && typeof c.text === "string")
            .map((c) => c.text)
            .join("");
          if (textContent) {
            responseText = textContent;
          }
        }
      }
    });

    try {
      // Run the agent
      await session.prompt(message);
    } finally {
      unsubscribe();
    }

    // Get model info
    const model = session.model;
    const modelName = model
      ? `${(model as any).provider}/${(model as any).modelId}`
      : undefined;

    // Update session store
    const modelProvider = model ? (model as any).provider : undefined;
    await updateSessionUsage({
      storePath,
      sessionKey,
      model: modelName,
      modelProvider,
    });

    // Save session store
    store[sessionKey] = {
      ...sessionEntry,
      updatedAt: Date.now(),
    };
    await saveSessionStore(storePath, store);

    return {
      response: responseText,
      sessionId,
      sessionKey,
      model: modelName,
    };
  } finally {
    cleanupEnv();
  }
}

/**
 * Reset a session (clear history and start fresh).
 */
export async function resetSession(params: {
  sessionKey?: string;
  config?: ClawdConfig;
}): Promise<{ sessionId: string; sessionKey: string }> {
  const { config } = params;
  const sessionKey = params.sessionKey ?? resolveMainSessionKey(config);
  const storePath = resolveStorePath(config?.session?.store);
  const store = loadSessionStore(storePath);

  // Resolve workspace
  const workspaceDir = config?.agent?.workspace
    ? resolveUserPath(config.agent.workspace)
    : path.join(os.homedir(), "clawd");

  // Sessions directory for transcripts
  const sessionsDir = path.dirname(storePath);
  await fs.promises.mkdir(sessionsDir, { recursive: true });

  // Create a new session using the SDK's SessionManager
  const sessionManager = SessionManager.create(workspaceDir, sessionsDir);
  const newSessionId = sessionManager.getSessionId();

  store[sessionKey] = {
    sessionId: newSessionId,
    updatedAt: Date.now(),
  };

  await saveSessionStore(storePath, store);

  return { sessionId: newSessionId, sessionKey };
}

/**
 * List all sessions.
 */
export function listSessions(params?: {
  config?: ClawdConfig;
}): Array<{ sessionKey: string; sessionId: string; updatedAt: number }> {
  const storePath = resolveStorePath(params?.config?.session?.store);
  const store = loadSessionStore(storePath);

  return Object.entries(store).map(([key, entry]) => ({
    sessionKey: key,
    sessionId: entry.sessionId,
    updatedAt: entry.updatedAt,
  }));
}
