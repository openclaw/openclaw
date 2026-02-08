import type { IncomingMessage, ServerResponse } from "node:http";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { xmtpPlugin } from "./src/channel.js";
import { setXmtpRuntime } from "./src/runtime.js";
import {
  handleSetup,
  handleSetupStatus,
  handleSetupComplete,
  handleSetupCancel,
} from "./src/setup.js";
import { registerXmtpCommands } from "./src/xmtp-commands.js";

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString();
  if (!raw.trim()) return {};
  return JSON.parse(raw) as Record<string, unknown>;
}

function jsonResponse(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

const plugin = {
  id: "xmtp",
  name: "XMTP",
  description: "XMTP decentralized messaging channel",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    setXmtpRuntime(api.runtime);
    api.registerChannel({ plugin: xmtpPlugin });
    registerXmtpCommands(api);

    api.registerGatewayMethod("xmtp.setup", async ({ params, respond }) => {
      try {
        const p = params as Record<string, unknown>;
        const result = await handleSetup({
          accountId: typeof p.accountId === "string" ? p.accountId : undefined,
          env: typeof p.env === "string" ? (p.env as "production" | "dev") : undefined,
        });
        respond(true, result, undefined);
      } catch (err) {
        respond(false, undefined, {
          code: -1,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    });

    api.registerGatewayMethod("xmtp.setup.status", async ({ respond }) => {
      respond(true, handleSetupStatus(), undefined);
    });

    api.registerGatewayMethod("xmtp.setup.complete", async ({ respond }) => {
      try {
        const result = await handleSetupComplete();
        respond(true, result, undefined);
      } catch (err) {
        respond(false, undefined, {
          code: -1,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    });

    api.registerGatewayMethod("xmtp.setup.cancel", async ({ respond }) => {
      const result = handleSetupCancel();
      respond(true, result, undefined);
    });

    api.registerHttpRoute({
      path: "/xmtp/setup",
      handler: async (req, res) => {
        if (req.method !== "POST") {
          jsonResponse(res, 405, { error: "Method Not Allowed" });
          return;
        }
        try {
          const body = await readJsonBody(req);
          const result = await handleSetup({
            accountId: typeof body.accountId === "string" ? body.accountId : undefined,
            env: typeof body.env === "string" ? (body.env as "production" | "dev") : undefined,
          });
          jsonResponse(res, 200, result);
        } catch (err) {
          jsonResponse(res, 500, { error: err instanceof Error ? err.message : String(err) });
        }
      },
    });

    api.registerHttpRoute({
      path: "/xmtp/setup/status",
      handler: async (req, res) => {
        if (req.method !== "GET") {
          jsonResponse(res, 405, { error: "Method Not Allowed" });
          return;
        }
        jsonResponse(res, 200, handleSetupStatus());
      },
    });

    api.registerHttpRoute({
      path: "/xmtp/setup/complete",
      handler: async (req, res) => {
        if (req.method !== "POST") {
          jsonResponse(res, 405, { error: "Method Not Allowed" });
          return;
        }
        try {
          const result = await handleSetupComplete();
          jsonResponse(res, 200, result);
        } catch (err) {
          jsonResponse(res, 400, { error: err instanceof Error ? err.message : String(err) });
        }
      },
    });

    api.registerHttpRoute({
      path: "/xmtp/setup/cancel",
      handler: async (req, res) => {
        if (req.method !== "POST") {
          jsonResponse(res, 405, { error: "Method Not Allowed" });
          return;
        }
        const result = handleSetupCancel();
        jsonResponse(res, 200, result);
      },
    });
  },
};

export default plugin;
