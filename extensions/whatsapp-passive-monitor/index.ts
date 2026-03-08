import { runPluginCommandWithTimeout } from "openclaw/plugin-sdk";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { createDebounceManager, type DebounceManager } from "./src/debounce.js";
import type { MeetingDetectorAgent } from "./src/detectors/meeting.js";
import { AgentRepositoryImpl } from "./src/repository/agent-repository.js";
import {
  MessageRepositoryImpl,
  type MessageRepository,
} from "./src/repository/message-repository.js";
import { OllamaRepositoryImpl } from "./src/repository/ollama-repository.js";
import { SqliteRepositoryImpl } from "./src/repository/sqlite-repository.js";
import { setupDetectors } from "./src/setup-detectors.js";
import { type PluginConfig } from "./src/types.js";

// Default configuration values
const DEFAULT_CONFIG: PluginConfig = {
  ollamaUrl: "http://localhost:11434",
  agents: [
    { name: "A", model: "qwen3.5:4b" },
    { name: "B", model: "llama3.1:8b" },
  ],
  debounceMs: 5000,

  contextMessageLimit: 20,
  dbPath: "passive/messages.db",
  outputDir: "passive",
};

/**
 * Agent A prompt — qwen3.5:4b
 * Rule-based classifier with clear TRUE/FALSE conditions.
 */
const buildAgentAPrompt = (conversation: string): string =>
  `You are a classifier. Analyze this WhatsApp conversation.

Determine:
1. has_agreed_to_meet: Have the participants agreed to physically meet in person?
2. has_agreed_date: Have they agreed on a specific date/time for meeting?

has_agreed_to_meet is TRUE when:
- Both participants commit to a physical in-person activity together (dinner, hiking, cycling, shopping, road trip, reunion, etc.)
- Agreement counts even if the exact date or location is not yet decided
- Someone initially declines but later changes their mind and agrees

has_agreed_to_meet is FALSE when:
- It is a video call, phone call, gaming session, or any online-only activity
- Plans were agreed but then CANCELLED by either party
- The arrangement is sarcastic or a joke (not genuine)
- They express vague wishes ("we should do something") without concrete commitment
- They are arranging something for OTHER people, not themselves
- There is no face-to-face contact (leaving items on doorstep, posting mail, picking up items)

has_agreed_date rules:
- If has_agreed_to_meet is false, has_agreed_date MUST also be false
- True ONLY if they agreed on a specific date or time for their physical meeting
- Mentioning a date in conversation is NOT enough — both must agree to it

Include a brief reason for your decision.

Respond with JSON only.

--- Conversation ---
${conversation}`;

/**
 * Agent B prompt — llama3.1:8b
 * Step-by-step classifier with emphasis on reading the entire conversation.
 */
const buildAgentBPrompt = (conversation: string): string =>
  `You are a classifier. Analyze this WhatsApp conversation.

Determine:
1. has_agreed_to_meet: Have the participants agreed to physically meet in person?
2. has_agreed_date: Have they agreed on a specific date/time for meeting?

STEP 1: Check if has_agreed_to_meet is TRUE. ALL of these must be true:
- The activity is PHYSICAL and in-person (NOT video calls, phone calls, FaceTime, gaming, or online activities)
- BOTH chatters will be PRESENT at the same place — if one person says they can't come, won't be there, or is away, the answer is FALSE
- The agreement is GENUINE (not sarcastic or joking)
- The commitment is CONCRETE (not vague wishes like "we should sometime" or "one of these days")
- The plans are NOT cancelled
- The chatters are meeting EACH OTHER (not just planning something for other people where one chatter won't attend)
- There IS face-to-face contact (not just errands like picking up items, posting mail, or leaving things at a doorstep)

IMPORTANT: Read the ENTIRE conversation. If someone initially seems interested but then DECLINES ("I can't", "I'm away", "I'm busy that day"), the final answer is what matters. A decline at the end overrides earlier enthusiasm. Only count it as TRUE if the person who declined later CHANGES THEIR MIND and genuinely agrees.

STEP 2: Check has_agreed_date:
- If has_agreed_to_meet is FALSE, has_agreed_date MUST be FALSE
- Otherwise, TRUE only if both agreed on a specific date/time for their physical meeting

Include a brief reason for your decision.

Respond with JSON only.

--- Conversation ---
${conversation}`;

export default function register(api: OpenClawPluginApi) {
  // TODO: Expose plugin via openclaw plugin in the future
  const config: PluginConfig = { ...DEFAULT_CONFIG };

  // Resolve DB path relative to openclaw workspace
  const resolvedDbPath = api.resolvePath(`~/.openclaw/workspace/${config.dbPath}`);

  let messageRepo: MessageRepository;
  try {
    const sqliteRepo = new SqliteRepositoryImpl(resolvedDbPath);
    messageRepo = new MessageRepositoryImpl(sqliteRepo);
  } catch (err) {
    api.logger.error?.(`whatsapp-passive-monitor: failed to open SQLite: ${String(err)}`);
    return;
  }

  // Prompt builders keyed by agent name
  const promptBuilders: Record<string, (conversation: string) => string> = {
    A: buildAgentAPrompt,
    B: buildAgentBPrompt,
  };

  // Create one OllamaRepository per agent, each bound to its model
  const agents: MeetingDetectorAgent[] = config.agents.map((agentConfig) => ({
    name: agentConfig.name,
    ollama: new OllamaRepositoryImpl(config.ollamaUrl, agentConfig.model),
    buildPrompt: promptBuilders[agentConfig.name],
  }));

  const agentRepo = new AgentRepositoryImpl(runPluginCommandWithTimeout);

  // Initialize all detectors and register them
  const registry = setupDetectors({ messageRepo, agents, agentRepo, logger: api.logger });

  // Debounce fires → run all detectors sequentially
  const onDebouncefire = (conversationId: string) => {
    registry
      .runAll({ conversationId })
      .catch((err) =>
        api.logger.error?.(`whatsapp-passive-monitor: registry error: ${String(err)}`),
      );
  };

  const debounce: DebounceManager = createDebounceManager(config.debounceMs, onDebouncefire);

  // ---- message_observed hook ----
  // Captures ALL WhatsApp messages (inbound + phone-typed outbound)
  // before access control. Stores in SQLite, resets debounce,
  // and returns { handled: true } to block agent dispatch.
  api.on("message_observed", async (event, ctx) => {
    if (ctx.channelId !== "whatsapp") return;

    messageRepo.insertMessage({
      conversation_id: ctx.conversationId ?? event.from,
      sender: event.fromMe ? "me" : event.from,
      sender_name: event.fromMe ? null : ((event.metadata?.pushName as string) ?? null),
      content: event.content,
      timestamp: event.timestamp ?? Date.now(),
      direction: event.fromMe ? "outbound" : "inbound",
      channel_id: "whatsapp",
    });

    // Reset debounce on ALL messages — wait for full conversation to settle
    debounce.touch(ctx.conversationId ?? event.from);

    // Block ALL WhatsApp messages from reaching the main agent
    return { handled: true };
  });
}
