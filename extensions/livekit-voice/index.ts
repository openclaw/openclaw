import { Type } from "@sinclair/typebox";
import type { GatewayRequestHandlerOptions, OpenClawPluginApi } from "openclaw/plugin-sdk";
import { LiveKitVoiceConfigSchema, type LiveKitVoiceConfig } from "./src/config.js";
import { generateToken, generateRoomName } from "./src/token-server.js";
import { createAgentRuntime, type AgentRuntime } from "./src/runtime.js";

const livekitVoiceConfigSchema = {
  parse(value: unknown): LiveKitVoiceConfig {
    const raw =
      value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};
    return LiveKitVoiceConfigSchema.parse(raw);
  },
  uiHints: {
    "livekit.apiKey": { label: "LiveKit API Key", sensitive: true },
    "livekit.apiSecret": { label: "LiveKit API Secret", sensitive: true },
    "livekit.url": { label: "LiveKit Server URL", placeholder: "ws://localhost:7880" },
    "agent.voice": { label: "Voice", placeholder: "Kore" },
    "owner.name": { label: "Owner Display Name" },
    "owner.identity": { label: "Owner Identity" },
    "owner.sessionKey": { label: "Owner Session Key" },
    "owner.roomPrefix": { label: "Room Name Prefix" },
    "agent.model": { label: "Realtime Model", placeholder: "gemini-live-2.5-flash-native-audio" },
    "frontend.publicUrl": { label: "Frontend Public URL" },
  },
};

const LiveKitCallToolSchema = Type.Object({
  action: Type.Optional(
    Type.String({
      description: 'Action: "start_session", "get_status", or "end_session"',
    }),
  ),
  room: Type.Optional(Type.String({ description: "Room name (auto-generated if omitted)" })),
});

const livekitVoicePlugin = {
  id: "livekit-voice",
  name: "LiveKit Voice",
  description: "Live voice calling via LiveKit with Gemini Native Audio",
  configSchema: livekitVoiceConfigSchema,

  register(api: OpenClawPluginApi) {
    const config = livekitVoiceConfigSchema.parse(api.pluginConfig);

    if (!config.enabled) {
      api.logger.info("[livekit-voice] Plugin disabled in config");
      return;
    }

    let agentRuntime: AgentRuntime | null = null;

    const getApiKey = () => config.livekit.apiKey || process.env.LIVEKIT_API_KEY || "";
    const getApiSecret = () => config.livekit.apiSecret || process.env.LIVEKIT_API_SECRET || "";
    const getGatewayToken = () => {
      const gwConfig = api.config as Record<string, unknown>;
      const gateway = gwConfig.gateway as Record<string, unknown> | undefined;
      const auth = gateway?.auth as Record<string, unknown> | undefined;
      return (auth?.token as string) || process.env.OPENCLAW_GATEWAY_TOKEN || "";
    };

    // --- Gateway Methods ---

    api.registerGatewayMethod(
      "livekit.token",
      async ({ params, respond }: GatewayRequestHandlerOptions) => {
        try {
          const apiKey = getApiKey();
          const apiSecret = getApiSecret();
          if (!apiKey || !apiSecret) {
            respond(false, { error: "LiveKit API key/secret not configured" });
            return;
          }

          const room = (typeof params?.room === "string" && params.room.trim()) || generateRoomName(config.owner.roomPrefix);
          const identity =
            (typeof params?.identity === "string" && params.identity.trim()) ||
            `user-${Math.floor(Math.random() * 10000)}`;
          const name = (typeof params?.name === "string" && params.name.trim()) || config.owner.name;

          const token = await generateToken(apiKey, apiSecret, room, identity, name);

          respond(true, {
            token,
            room,
            identity,
            serverUrl: config.livekit.url,
          });
        } catch (err) {
          respond(false, { error: err instanceof Error ? err.message : String(err) });
        }
      },
    );

    api.registerGatewayMethod(
      "livekit.status",
      async ({ respond }: GatewayRequestHandlerOptions) => {
        respond(true, {
          agentRunning: agentRuntime?.isRunning ?? false,
          livekitUrl: config.livekit.url,
          frontendUrl: config.frontend.publicUrl || null,
        });
      },
    );

    api.registerGatewayMethod(
      "livekit.rooms",
      async ({ respond }: GatewayRequestHandlerOptions) => {
        try {
          const { RoomServiceClient } = await import("livekit-server-sdk");
          const apiKey = getApiKey();
          const apiSecret = getApiSecret();
          if (!apiKey || !apiSecret) {
            respond(false, { error: "LiveKit API key/secret not configured" });
            return;
          }

          const httpUrl = config.livekit.url.replace(/^ws/, "http");
          const roomService = new RoomServiceClient(httpUrl, apiKey, apiSecret);
          const rooms = await roomService.listRooms();
          respond(true, {
            rooms: rooms.map((r) => ({
              name: r.name,
              numParticipants: r.numParticipants,
              creationTime: r.creationTime,
            })),
          });
        } catch (err) {
          respond(false, { error: err instanceof Error ? err.message : String(err) });
        }
      },
    );

    // --- HTTP Route (token endpoint for frontend) ---

    api.registerHttpRoute({
      path: "/__openclaw__/livekit/token",
      handler: async (req, res) => {
        if (req.method !== "POST") {
          res.writeHead(405);
          res.end("Method Not Allowed");
          return;
        }

        try {
          const apiKey = getApiKey();
          const apiSecret = getApiSecret();
          if (!apiKey || !apiSecret) {
            res.writeHead(500);
            res.end(JSON.stringify({ error: "LiveKit API key/secret not configured" }));
            return;
          }

          const room = generateRoomName(config.owner.roomPrefix);
          const identity = `user-${Math.floor(Math.random() * 10000)}`;
          const token = await generateToken(apiKey, apiSecret, room, identity, config.owner.name);

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              serverUrl: config.livekit.url,
              roomName: room,
              participantName: config.owner.name,
              participantToken: token,
            }),
          );
        } catch (err) {
          res.writeHead(500);
          res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
        }
      },
    });

    // --- Agent Tool ---

    api.registerTool({
      name: "livekit_call",
      label: "LiveKit Voice Call",
      description:
        "Start, check, or end a live voice call session via LiveKit. The user can join via the web frontend.",
      parameters: LiveKitCallToolSchema,
      async execute(_toolCallId, params) {
        const json = (payload: unknown) => ({
          content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
          details: payload,
        });

        try {
          const action = typeof params?.action === "string" ? params.action : "start_session";

          switch (action) {
            case "start_session": {
              const apiKey = getApiKey();
              const apiSecret = getApiSecret();
              if (!apiKey || !apiSecret) {
                return json({ error: "LiveKit API key/secret not configured" });
              }

              const room =
                (typeof params?.room === "string" && params.room.trim()) || generateRoomName(config.owner.roomPrefix);
              const token = await generateToken(apiKey, apiSecret, room, config.owner.identity, config.owner.name);

              const frontendUrl = config.frontend.publicUrl;
              return json({
                status: "room_created",
                room,
                serverUrl: config.livekit.url,
                token,
                joinUrl: frontendUrl || "Open the LiveKit frontend to join",
                agentRunning: agentRuntime?.isRunning ?? false,
              });
            }

            case "get_status": {
              return json({
                agentRunning: agentRuntime?.isRunning ?? false,
                livekitUrl: config.livekit.url,
              });
            }

            case "end_session": {
              const room = typeof params?.room === "string" ? params.room.trim() : "";
              if (!room) {
                return json({ error: "room name required to end session" });
              }

              try {
                const { RoomServiceClient } = await import("livekit-server-sdk");
                const httpUrl = config.livekit.url.replace(/^ws/, "http");
                const roomService = new RoomServiceClient(httpUrl, getApiKey(), getApiSecret());
                await roomService.deleteRoom(room);
                return json({ status: "room_deleted", room });
              } catch (err) {
                return json({ error: err instanceof Error ? err.message : String(err) });
              }
            }

            default:
              return json({ error: `Unknown action: ${action}` });
          }
        } catch (err) {
          return json({ error: err instanceof Error ? err.message : String(err) });
        }
      },
    });

    // --- CLI Commands ---

    api.registerCli(
      ({ program }) => {
        const lk = program.command("livekit").description("LiveKit voice call management");

        lk.command("status")
          .description("Show LiveKit agent & room status")
          .action(async () => {
            console.log(`Agent running: ${agentRuntime?.isRunning ?? false}`);
            console.log(`LiveKit URL:   ${config.livekit.url}`);
            console.log(`Frontend:      ${config.frontend.publicUrl || "not configured"}`);
          });

        lk.command("token")
          .description("Generate a LiveKit participant token")
          .option("--room <room>", "Room name")
          .option("--identity <identity>", "Participant identity")
          .action(async (opts: { room?: string; identity?: string }) => {
            const apiKey = getApiKey();
            const apiSecret = getApiSecret();
            if (!apiKey || !apiSecret) {
              console.error("Error: LiveKit API key/secret not configured");
              return;
            }
            const room = opts.room || generateRoomName(config.owner.roomPrefix);
            const identity = opts.identity || `user-${Math.floor(Math.random() * 10000)}`;
            const token = await generateToken(apiKey, apiSecret, room, identity, config.owner.name);
            console.log(`Room:     ${room}`);
            console.log(`Identity: ${identity}`);
            console.log(`Token:    ${token}`);
            console.log(`URL:      ${config.livekit.url}`);
          });

        lk.command("start")
          .description("Start the LiveKit agent process")
          .action(async () => {
            if (agentRuntime?.isRunning) {
              console.log("Agent is already running");
              return;
            }
            if (!agentRuntime) {
              agentRuntime = createAgentRuntime(config, getGatewayToken(), api.logger);
            }
            await agentRuntime.start();
            console.log("Agent started");
          });

        lk.command("stop")
          .description("Stop the LiveKit agent process")
          .action(async () => {
            if (!agentRuntime?.isRunning) {
              console.log("Agent is not running");
              return;
            }
            await agentRuntime.stop();
            console.log("Agent stopped");
          });
      },
      { commands: ["livekit"] },
    );

    // --- Service (background process lifecycle) ---

    api.registerService({
      id: "livekit-voice",
      start: async () => {
        if (!config.enabled) return;

        const apiKey = getApiKey();
        const apiSecret = getApiSecret();
        if (!apiKey || !apiSecret) {
          api.logger.warn(
            "[livekit-voice] API key/secret not configured — agent process will not auto-start",
          );
          return;
        }

        agentRuntime = createAgentRuntime(config, getGatewayToken(), api.logger);
        await agentRuntime.start();
      },
      stop: async () => {
        if (agentRuntime) {
          await agentRuntime.stop();
          agentRuntime = null;
        }
      },
    });
  },
};

export default livekitVoicePlugin;
