import { Type } from "@sinclair/typebox";

type VoiceCallConfig =
  | {
      provider: "twilio";
      twilio: {
        accountSid: string;
        authToken: string;
        from: string;
        statusCallbackUrl?: string;
        twimlUrl?: string;
      };
    }
  | {
      provider?: "log";
    };

type VoiceCallStartParams = {
  to: string;
  message?: string;
};

type VoiceCallStatus = {
  sid: string;
  status: string;
  provider: string;
  to?: string;
  from?: string;
};

const voiceCallConfigSchema = {
  parse(value: unknown): VoiceCallConfig {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return { provider: "log" };
    }
    const cfg = value as Record<string, unknown>;
    const provider =
      cfg.provider === "twilio" || cfg.provider === "log"
        ? cfg.provider
        : "log";
    if (provider === "twilio") {
      const twilio = cfg.twilio as Record<string, unknown> | undefined;
      if (
        !twilio ||
        typeof twilio.accountSid !== "string" ||
        typeof twilio.authToken !== "string" ||
        typeof twilio.from !== "string"
      ) {
        throw new Error(
          "twilio provider requires twilio.accountSid, twilio.authToken, twilio.from",
        );
      }
      return {
        provider: "twilio",
        twilio: {
          accountSid: twilio.accountSid,
          authToken: twilio.authToken,
          from: twilio.from,
          statusCallbackUrl:
            typeof twilio.statusCallbackUrl === "string"
              ? twilio.statusCallbackUrl
              : undefined,
          twimlUrl:
            typeof twilio.twimlUrl === "string" ? twilio.twimlUrl : undefined,
        },
      };
    }
    return { provider: "log" };
  },
  uiHints: {
    provider: {
      label: "Provider",
      help: 'Use "twilio" for real calls or "log" for dev/no-network.',
    },
    "twilio.accountSid": {
      label: "Twilio Account SID",
      placeholder: "ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    },
    "twilio.authToken": {
      label: "Twilio Auth Token",
      sensitive: true,
      placeholder: "••••••••••••••••",
    },
    "twilio.from": {
      label: "Twilio From (E.164)",
      placeholder: "+15551234567",
    },
    "twilio.statusCallbackUrl": {
      label: "Status Callback URL",
      placeholder: "https://example.com/twilio-status",
      advanced: true,
    },
    "twilio.twimlUrl": {
      label: "TwiML URL",
      placeholder: "https://example.com/twiml",
      advanced: true,
    },
  },
};

const escapeXml = (input: string): string =>
  input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");

async function startTwilioCall(
  cfg: Exclude<VoiceCallConfig, { provider?: "log" }>["twilio"],
  params: VoiceCallStartParams,
): Promise<VoiceCallStatus> {
  const body = new URLSearchParams();
  body.set("To", params.to);
  body.set("From", cfg.from);

  if (cfg.twimlUrl) {
    body.set("Url", cfg.twimlUrl);
  } else {
    const say = escapeXml(params.message ?? "Hello from Clawdbot.");
    body.set("Twiml", `<Response><Say>${say}</Say></Response>`);
  }
  if (cfg.statusCallbackUrl) {
    body.set("StatusCallback", cfg.statusCallbackUrl);
  }

  const res = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${cfg.accountSid}/Calls.json`,
    {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${cfg.accountSid}:${cfg.authToken}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    },
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`twilio call failed: ${res.status} ${text}`);
  }
  const payload = (await res.json()) as Record<string, unknown>;
  return {
    sid: String(payload.sid ?? ""),
    status: String(payload.status ?? "unknown"),
    provider: "twilio",
    to: String(payload.to ?? params.to),
    from: String(payload.from ?? cfg.from),
  };
}

async function getTwilioStatus(
  cfg: Exclude<VoiceCallConfig, { provider?: "log" }>["twilio"],
  sid: string,
): Promise<VoiceCallStatus> {
  const res = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${cfg.accountSid}/Calls/${sid}.json`,
    {
      method: "GET",
      headers: {
        Authorization: `Basic ${Buffer.from(`${cfg.accountSid}:${cfg.authToken}`).toString("base64")}`,
      },
    },
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`twilio status failed: ${res.status} ${text}`);
  }
  const payload = (await res.json()) as Record<string, unknown>;
  return {
    sid,
    status: String(payload.status ?? "unknown"),
    provider: "twilio",
    to: String(payload.to ?? ""),
    from: String(payload.from ?? cfg.from),
  };
}

async function startCall(
  cfg: VoiceCallConfig,
  params: VoiceCallStartParams,
): Promise<VoiceCallStatus> {
  if (cfg.provider === "twilio") {
    return startTwilioCall(cfg.twilio, params);
  }
  return {
    sid: `log-${Date.now()}`,
    status: "queued",
    provider: "log",
    to: params.to,
  };
}

async function getStatus(
  cfg: VoiceCallConfig,
  sid: string,
): Promise<VoiceCallStatus> {
  if (cfg.provider === "twilio") {
    return getTwilioStatus(cfg.twilio, sid);
  }
  return { sid, status: "mock", provider: "log" };
}

const voiceCallPlugin = {
  id: "voice-call",
  name: "Voice Call",
  description: "Voice-call plugin with Twilio/log providers",
  configSchema: voiceCallConfigSchema,
  register(api) {
    const cfg = voiceCallConfigSchema.parse(api.pluginConfig);

    api.registerGatewayMethod("voicecall.start", async ({ params, respond }) => {
      const to = typeof params?.to === "string" ? params.to.trim() : "";
      const message =
        typeof params?.message === "string" ? params.message.trim() : undefined;
      if (!to) {
        respond(false, { error: "to required" });
        return;
      }
      try {
        const result = await startCall(cfg, { to, message });
        respond(true, result);
      } catch (err) {
        respond(false, { error: String(err) });
      }
    });

    api.registerGatewayMethod(
      "voicecall.status",
      async ({ params, respond }) => {
        const sid = typeof params?.sid === "string" ? params.sid.trim() : "";
        if (!sid) {
          respond(false, { error: "sid required" });
          return;
        }
        try {
          const result = await getStatus(cfg, sid);
          respond(true, result);
        } catch (err) {
          respond(false, { error: String(err) });
        }
      },
    );

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
          sid: Type.Optional(Type.String({ description: "Call SID" })),
          message: Type.Optional(
            Type.String({ description: "Optional intro message" }),
          ),
        }),
        async execute(_toolCallId, params) {
          const mode = params.mode ?? "call";
          if (mode === "status") {
            if (typeof params.sid !== "string") {
              throw new Error("sid required for status");
            }
            const status = await getStatus(cfg, params.sid.trim());
            return {
              content: [{ type: "text", text: JSON.stringify(status, null, 2) }],
              details: status,
            };
          }
          const to =
            typeof params.to === "string" && params.to.trim()
              ? params.to.trim()
              : null;
          if (!to) throw new Error("to required for call");
          const result = await startCall(cfg, { to, message: params.message });
          return {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
            details: result,
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
        .command("start")
        .description("Start a voice call")
        .requiredOption("--to <target>", "Target to call")
        .option("--message <text>", "Optional intro message")
        .action(async (opts) => {
          const result = await startCall(cfg, {
            to: opts.to,
            message: opts.message,
          });
          console.log(JSON.stringify(result, null, 2));
        });

      voicecall
        .command("status")
        .description("Show voice-call status")
        .requiredOption("--sid <sid>", "Call SID")
        .action(async (opts) => {
          const result = await getStatus(cfg, opts.sid);
          console.log(JSON.stringify(result, null, 2));
        });
    }, { commands: ["voicecall"] });

    api.registerService({
      id: "voicecall",
      start: () => {
        api.logger.info(`voice-call provider: ${cfg.provider}`);
      },
      stop: () => {
        api.logger.info("voice-call service stopped");
      },
    });
  },
};

export default voiceCallPlugin;
