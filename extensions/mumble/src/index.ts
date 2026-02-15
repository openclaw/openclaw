/**
 * OpenClaw Mumble Voice Chat Plugin
 *
 * Enables voice conversation with OpenClaw agents via Mumble.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { Client, type FullAudioPacket } from "@tf2pickup-org/mumble-client";
import fetch from "node-fetch";
import { VoiceChatClient, type VoiceMessage } from "./voice-chat-client.js";

interface MumblePluginConfig {
  enabled?: boolean;
  mumble?: {
    host: string;
    port: number;
    username: string;
    password?: string;
    channel?: string;
  };
  agent?: {
    sessionKey?: string;
  };
  audio?: {
    whisperUrl: string;
    kokoroUrl: string;
    kokoroVoice: string;
  };
  processing?: {
    minSpeechDurationMs?: number;
    silenceTimeoutMs?: number;
    allowFrom?: string[]; // Mumble usernames allowed to talk to the bot (empty = allow all)
  };
  gateway?: {
    url?: string; // Gateway URL (default: http://localhost:18789)
    token?: string; // Gateway token (from openclaw.json)
  };
}

export default {
  id: "mumble",
  name: "Mumble Voice Chat",
  description: "Voice chat integration for Mumble",

  register(api: OpenClawPluginApi) {
    const config = api.pluginConfig as MumblePluginConfig | undefined;

    // Graceful disable if not configured
    if (!config?.enabled) {
      api.logger.info("[mumble] plugin disabled (set enabled: true to activate)");
      return;
    }

    // Validate required configuration
    if (!config.mumble?.host || !config.mumble?.username) {
      api.logger.error("[mumble] missing required config: mumble.host and mumble.username");
      return;
    }

    if (!config.audio?.whisperUrl || !config.audio?.kokoroUrl || !config.audio?.kokoroVoice) {
      api.logger.error("[mumble] missing required audio config");
      return;
    }

    const gatewayUrl = config.gateway?.url || "http://localhost:18789";
    const gatewayToken = config.gateway?.token || "";

    api.logger.info(`[mumble] initializing voice chat`);
    api.logger.info(
      `[mumble] connecting to ${config.mumble.host}:${config.mumble.port || 64738} as ${config.mumble.username}`,
    );
    api.logger.info(`[mumble] gateway: ${gatewayUrl}`);

    let voiceClient: VoiceChatClient | null = null;
    let mumbleClient: Client | null = null;

    // Helper to get response from agent via chat completions API (synchronous)
    const getAgentResponse = async (text: string, username: string): Promise<string> => {
      try {
        const response = await fetch(`${gatewayUrl}/v1/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(gatewayToken ? { Authorization: `Bearer ${gatewayToken}` } : {}),
          },
          body: JSON.stringify({
            model: "openclaw:main",
            messages: [
              {
                role: "system",
                content:
                  "This is a VOICE conversation via Mumble. Your response will be spoken aloud using TTS. DO NOT use emojis, symbols, markdown, bullet points, or any special formatting. Write natural, conversational speech only. Keep responses concise (under 3 sentences).",
              },
              {
                role: "user",
                content: `[Voice from ${username}]: ${text}`,
              },
            ],
            user: `mumble-extension:${username}`,
          }),
        });

        if (!response.ok) {
          const error = await response.text();
          throw new Error(`Chat completions API error: ${response.status} ${error}`);
        }

        const data = (await response.json()) as any;
        const choices = data.choices || [];
        if (choices.length > 0 && choices[0].message?.content) {
          return choices[0].message.content.trim();
        }

        return "";
      } catch (err) {
        api.logger.error(`[mumble] error getting agent response: ${err}`);
        throw err;
      }
    };

    // Register service with lifecycle
    api.registerService({
      id: "mumble",

      start: async () => {
        try {
          api.logger.info("[mumble] starting voice chat service");

          // Initialize voice chat client
          voiceClient = new VoiceChatClient({
            mumbleHost: config.mumble!.host,
            mumblePort: config.mumble!.port || 64738,
            mumbleUsername: config.mumble!.username,
            mumblePassword: config.mumble!.password,
            mumbleChannel: config.mumble!.channel,
            agentSessionKey: config.agent?.sessionKey,
            whisperUrl: config.audio!.whisperUrl,
            kokoroUrl: config.audio!.kokoroUrl,
            kokoroVoice: config.audio!.kokoroVoice,
            minSpeechDurationMs: config.processing?.minSpeechDurationMs,
            silenceTimeoutMs: config.processing?.silenceTimeoutMs,
            allowFrom: config.processing?.allowFrom,
          });

          // Initialize codecs
          await voiceClient.initialize();

          if (config.processing?.allowFrom && config.processing.allowFrom.length > 0) {
            api.logger.info(
              `[mumble] voice chat client initialized with allowlist: ${config.processing.allowFrom.join(", ")}`,
            );
          } else {
            api.logger.info("[mumble] voice chat client initialized (all users allowed)");
          }

          // Connect to Mumble server
          mumbleClient = new Client({
            host: config.mumble!.host,
            port: config.mumble!.port || 64738,
            username: config.mumble!.username,
            password: config.mumble!.password,
            rejectUnauthorized: false, // Accept self-signed certificates
          });

          await mumbleClient.connect();

          if (mumbleClient.isConnected()) {
            api.logger.info("[mumble] connected to Mumble server");

            // Set socket and user manager for voice client
            voiceClient.setSocket(mumbleClient.socket);
            voiceClient.setUserManager(mumbleClient.users);

            // Subscribe to audio packets
            mumbleClient.socket.fullAudioPacket.subscribe(async (packet: FullAudioPacket) => {
              if (voiceClient) {
                try {
                  await voiceClient.handleAudioPacket(packet);
                } catch (err) {
                  api.logger.error(
                    `[mumble] audio packet error: ${err instanceof Error ? err.message : String(err)}`,
                  );
                }
              }
            });

            api.logger.info("[mumble] audio packet subscription active");
          }

          // Handle voice messages from users
          voiceClient.on("voiceMessage", async (msg: VoiceMessage) => {
            try {
              api.logger.info(
                `[mumble] voice message from ${msg.username}: "${msg.text.substring(0, 100)}..."`,
              );

              // Get response from agent (synchronous)
              try {
                const responseText = await getAgentResponse(msg.text, msg.username);

                if (responseText && voiceClient) {
                  api.logger.info(
                    `[mumble] got response (${responseText.length} chars), speaking...`,
                  );
                  await voiceClient.speak(responseText);
                  api.logger.info("[mumble] response spoken successfully");
                } else {
                  api.logger.warn("[mumble] no response from agent");
                }
              } catch (err) {
                api.logger.error(`[mumble] error getting/speaking response: ${err}`);

                // Fallback: respond with error message
                if (voiceClient) {
                  await voiceClient.speak("Sorry, I'm having trouble responding right now.");
                }
              }
            } catch (err) {
              api.logger.error(`[mumble] error handling voice message: ${err}`);
            }
          });

          // Handle errors
          voiceClient.on("error", (error: Error) => {
            api.logger.error(`[mumble] voice client error: ${error.message}`);
          });

          api.logger.info("[mumble] voice chat service started successfully 🎤");
        } catch (err) {
          api.logger.error(`[mumble] failed to start: ${err}`);
          throw err;
        }
      },

      stop: async () => {
        api.logger.info("[mumble] stopping voice chat service");

        // Disconnect Mumble client
        if (mumbleClient) {
          mumbleClient.disconnect();
          mumbleClient = null;
        }

        // Clean up voice client
        if (voiceClient) {
          await voiceClient.cleanup();
          voiceClient = null;
        }

        api.logger.info("[mumble] voice chat service stopped");
      },
    });

    // Register HTTP handler for proactive speaking
    api.registerHttpHandler(async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
      const url = new URL(req.url ?? "/", "http://localhost");

      // Only handle POST /mumble/speak
      if (req.method !== "POST" || url.pathname !== "/mumble/speak") {
        return false;
      }

      api.logger.info(`[mumble] HTTP handler called: ${req.method} ${url.pathname}`);

      try {
        // Parse JSON body
        const chunks: Buffer[] = [];
        req.on("data", (chunk) => chunks.push(chunk));

        await new Promise<void>((resolve, reject) => {
          req.on("end", () => resolve());
          req.on("error", reject);
        });

        const body = JSON.parse(Buffer.concat(chunks).toString()) as {
          text?: string;
          voice?: string;
        };

        if (!body.text) {
          res.statusCode = 400;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ error: "Missing required field: text" }));
          return true;
        }

        if (!voiceClient) {
          res.statusCode = 503;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ error: "Voice client not initialized" }));
          return true;
        }

        const voiceInfo = body.voice ? ` with voice "${body.voice}"` : "";
        api.logger.info(
          `[mumble] proactive speak request${voiceInfo}: "${body.text.substring(0, 50)}..."`,
        );

        // Speak the text (with optional voice override)
        await voiceClient.speak(body.text, body.voice);

        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ success: true, message: "Speech queued" }));
        return true;
      } catch (err) {
        api.logger.error(`[mumble] proactive speak error: ${err}`);
        res.statusCode = 500;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: String(err) }));
        return true;
      }
    });

    api.logger.info("[mumble] plugin registered successfully");
    api.logger.info("[mumble] HTTP endpoint available at: POST /mumble/speak");
  },
};
