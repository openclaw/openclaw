import { Type } from "@sinclair/typebox";

const voiceCallConfigSchema = {
  parse(value) {
    if (value === undefined) return {};
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("voice-call config must be an object");
    }
    return value;
  },
};

const voiceCallPlugin = {
  id: "voice-call",
  name: "Voice Call",
  description: "Voice-call plugin stub (placeholder)",
  configSchema: voiceCallConfigSchema,
  register(api) {
  api.registerGatewayMethod("voicecall.status", ({ respond }) => {
    respond(true, {
      status: "idle",
      provider: api.pluginConfig?.provider ?? "unset",
    });
  });

  api.registerTool(
    {
      name: "voice_call",
      label: "Voice Call",
      description: "Start or inspect a voice call via the voice-call plugin",
      parameters: Type.Object({
        mode: Type.Optional(
          Type.Union([Type.Literal("call"), Type.Literal("status")]),
        ),
        to: Type.Optional(Type.String({ description: "Call target" })),
        message: Type.Optional(
          Type.String({ description: "Optional intro message" }),
        ),
      }),
      async execute(_toolCallId, params) {
        if (params.mode === "status") {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({ status: "idle" }, null, 2),
              },
            ],
            details: { status: "idle" },
          };
        }
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  status: "not_implemented",
                  to: params.to ?? null,
                  message: params.message ?? null,
                },
                null,
                2,
              ),
            },
          ],
          details: {
            status: "not_implemented",
            to: params.to ?? null,
            message: params.message ?? null,
          },
        };
      },
    },
    { name: "voice_call" },
  );

  api.registerCli(({ program }) => {
    const voicecall = program
      .command("voicecall")
      .description("Voice call plugin commands");

    voicecall
      .command("status")
      .description("Show voice-call status")
      .action(() => {
        console.log(JSON.stringify({ status: "idle" }, null, 2));
      });

    voicecall
      .command("start")
      .description("Start a voice call (placeholder)")
      .option("--to <target>", "Target to call")
      .option("--message <text>", "Optional intro message")
      .action((opts) => {
        console.log(
          JSON.stringify(
            {
              status: "not_implemented",
              to: opts.to ?? null,
              message: opts.message ?? null,
            },
            null,
            2,
          ),
        );
      });
  }, { commands: ["voicecall"] });

  api.registerService({
    id: "voicecall",
    start: () => {
      api.logger.info("voice-call service ready (placeholder)");
    },
    stop: () => {
      api.logger.info("voice-call service stopped (placeholder)");
    },
  });
  },
};

export default voiceCallPlugin;
