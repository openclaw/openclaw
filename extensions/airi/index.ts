/**
 * OpenClaw AIRI Extension — Bridges the OpenClaw agent to an AIRI
 * avatar frontend for embodied AI interaction with VRM/Live2D avatars,
 * lip-synced TTS, and emotion-driven animations.
 */

import { randomUUID } from "node:crypto";
import type {
  GatewayRequestHandlerOptions,
  OpenClawPluginApi,
} from "openclaw/plugin-sdk/core";
import { AiriBridge } from "./src/bridge.js";
import { AiriConfigSchema, resolveAiriConfig, validateAiriConfig } from "./src/config.js";
import type {
  AiriEmotion,
  AiriInboundMessage,
  AiriUserSpeech,
  AiriUserText,
} from "./src/protocol.js";

// ── Emotion heuristics ───────────────────────────────────────────────

const EMOTION_PATTERNS: Array<[RegExp, AiriEmotion, number]> = [
  [/[!]{2,}|\b(?:wow|amazing|incredible|awesome)\b/i, "surprised", 0.8],
  [/\b(?:sorry|unfortunately|sadly|regret)\b/i, "sad", 0.6],
  [/\b(?:haha|lol|😂|😄|great|glad|happy|wonderful)\b/i, "happy", 0.7],
  [/\b(?:hmm|let me think|consider|perhaps|maybe|well)\b/i, "thinking", 0.5],
];

function detectEmotion(text: string): { emotion: AiriEmotion; intensity: number } | null {
  for (const [pattern, emotion, intensity] of EMOTION_PATTERNS) {
    if (pattern.test(text)) return { emotion, intensity };
  }
  return null;
}

// ── Plugin definition ────────────────────────────────────────────────

const plugin = {
  id: "airi",
  name: "AIRI Avatar",
  description:
    "Embodied AI companion with VRM/Live2D avatar, lip-synced TTS, and emotion-driven animations",
  configSchema: AiriConfigSchema,

  register(api: OpenClawPluginApi) {
    const rawConfig = (api.pluginConfig ?? {}) as Record<string, unknown>;
    const parsed = AiriConfigSchema.safeParse(rawConfig);
    if (!parsed.success) {
      api.logger.warn(`[airi] invalid config: ${parsed.error.message}`);
      return;
    }

    const config = resolveAiriConfig(parsed.data);
    const validation = validateAiriConfig(config);
    if (!validation.valid) {
      api.logger.warn(`[airi] config errors: ${validation.errors.join("; ")}`);
      return;
    }

    if (!config.enabled) {
      api.logger.info("[airi] plugin disabled via config");
      return;
    }

    const bridge = new AiriBridge(config, api.logger);

    // ── Handle inbound messages from AIRI frontend ─────────────

    bridge.on("message", (msg: AiriInboundMessage) => {
      switch (msg.type) {
        case "airi:user:text":
          handleUserText(msg, api);
          break;
        case "airi:user:speech":
          handleUserSpeech(msg, api);
          break;
        case "airi:user:action":
          api.logger.info(`[airi] user action: ${msg.action}`);
          break;
      }
    });

    // ── Hook: Forward agent text to AIRI ───────────────────────

    api.on("message_sending", async (event: { content?: string }) => {
      const text = event.content ?? "";
      if (!text) return;

      // Send text message
      bridge.send({
        type: "airi:text",
        id: randomUUID(),
        agentId: api.id,
        text,
        timestamp: new Date().toISOString(),
        streaming: false,
      });

      // Detect and send emotion
      const detected = detectEmotion(text);
      if (detected) {
        bridge.send({
          type: "airi:emotion",
          emotion: detected.emotion,
          intensity: detected.intensity,
        });
      }

      // Update avatar state
      bridge.send({
        type: "airi:status",
        avatarState: "speaking",
        agentId: api.id,
        connected: true,
      });
    });

    // ── Hook: Set avatar to "thinking" while agent runs ────────

    api.on("before_prompt_build", async () => {
      bridge.send({
        type: "airi:status",
        avatarState: "thinking",
        agentId: api.id,
        connected: true,
      });
    });

    api.on("agent_end", async () => {
      bridge.send({
        type: "airi:status",
        avatarState: "idle",
        agentId: api.id,
        connected: true,
      });
    });

    // ── Gateway methods ────────────────────────────────────────

    api.registerGatewayMethod("airi.status", async ({ respond }: GatewayRequestHandlerOptions) => {
      respond(true, {
        state: bridge.getState(),
        enabled: config.enabled,
        host: config.host,
        port: config.port,
        avatar: config.avatar,
      });
    });

    api.registerGatewayMethod("airi.emotion", async ({ params, respond }: GatewayRequestHandlerOptions) => {
      const emotion = typeof params?.emotion === "string" ? params.emotion : null;
      const intensity =
        typeof params?.intensity === "number" ? params.intensity : 0.7;

      if (!emotion) {
        respond(false, undefined, { code: "MISSING_PARAM", message: "emotion is required" });
        return;
      }

      const sent = bridge.send({
        type: "airi:emotion",
        emotion: emotion as AiriEmotion,
        intensity: Math.max(0, Math.min(1, intensity)),
      });
      respond(sent, sent ? { emotion, intensity } : undefined);
    });

    api.registerGatewayMethod("airi.action", async ({ params, respond }: GatewayRequestHandlerOptions) => {
      const action = typeof params?.action === "string" ? params.action : null;
      if (!action) {
        respond(false, undefined, { code: "MISSING_PARAM", message: "action is required" });
        return;
      }
      const sent = bridge.send({
        type: "airi:action",
        action: action as any,
      });
      respond(sent, sent ? { action } : undefined);
    });

    api.registerGatewayMethod("airi.config", async ({ respond }: GatewayRequestHandlerOptions) => {
      bridge.send({
        type: "airi:config",
        avatar: config.avatar,
        agentName: api.name,
      });
      respond(true, { synced: true });
    });

    // ── Service lifecycle ──────────────────────────────────────

    api.registerService({
      id: "airi-bridge",
      start: async () => {
        bridge.connect();
        api.logger.info(
          `[airi] bridge service started → ws://${config.host}:${config.port}`,
        );
      },
      stop: async () => {
        bridge.close();
        api.logger.info("[airi] bridge service stopped");
      },
    });
  },
};

// ── Inbound message handlers ─────────────────────────────────────────

function handleUserText(msg: AiriUserText, api: OpenClawPluginApi): void {
  api.logger.info(`[airi] user text: ${msg.text.slice(0, 80)}`);
  api.runtime.system.enqueueSystemEvent(msg.text, {
    sessionKey: "airi",
    contextKey: "airi-avatar",
  });
}

function handleUserSpeech(msg: AiriUserSpeech, api: OpenClawPluginApi): void {
  api.logger.info(`[airi] user speech: ${msg.format} ${msg.sampleRate}Hz`);
  // Write audio to temp file and transcribe via STT
  const fs = require("node:fs") as typeof import("node:fs");
  const os = require("node:os") as typeof import("node:os");
  const path = require("node:path") as typeof import("node:path");
  const audioBuffer = Buffer.from(msg.audio, "base64");
  const tmpPath = path.join(os.tmpdir(), `airi-speech-${Date.now()}.${msg.format}`);
  fs.writeFileSync(tmpPath, audioBuffer);
  const cfg = api.runtime.config.loadConfig();
  api.runtime.stt
    .transcribeAudioFile({ filePath: tmpPath, cfg })
    .then((result: { text: string | undefined }) => {
      // Clean up temp file
      fs.unlink(tmpPath, () => {});
      if (result.text) {
        api.runtime.system.enqueueSystemEvent(result.text, {
          sessionKey: "airi",
          contextKey: "airi-avatar-speech",
        });
      }
    })
    .catch((err: unknown) => {
      fs.unlink(tmpPath, () => {});
      const errMsg = err instanceof Error ? err.message : String(err);
      api.logger.error(`[airi] STT failed: ${errMsg}`);
    });
}

export default plugin;
