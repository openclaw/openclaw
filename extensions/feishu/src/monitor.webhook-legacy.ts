import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extractErrorCode } from "openclaw/plugin-sdk/error-runtime";
import * as webhookIngressSdk from "openclaw/plugin-sdk/webhook-ingress";

// Shipped 2026.9.6 hosts lack Gateway-owned forwarding. Retire this adapter when
// Feishu's declared host floor includes that listener capability.
export const feishuWebhookHost: Partial<
  Pick<typeof webhookIngressSdk, "getWebhookLegacyListener">
> = webhookIngressSdk;

export async function startFeishuLegacyWebhookListener(params: {
  endpoint: { port: number; host: string };
  handleRequest: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
  onFailure: (error: Error) => void;
  onRequestError: (error: unknown) => void;
}) {
  const server = createServer((req, res) => {
    void params.handleRequest(req, res).catch((error: unknown) => {
      params.onRequestError(error);
      if (!res.headersSent) {
        res.statusCode = 500;
      }
      res.end();
    });
  });
  let closing: Promise<void> | undefined;
  const stopAccepting = () => {
    closing ??= new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error && extractErrorCode(error) !== "ERR_SERVER_NOT_RUNNING") {
          reject(error);
        } else {
          resolve();
        }
      });
    });
    // The transport joins any close error after its authenticated response drain.
    void closing.catch(() => {});
  };
  const close = async () => {
    stopAccepting();
    server.closeAllConnections();
    try {
      await closing;
    } finally {
      server.off("error", params.onFailure);
    }
  };
  server.on("error", params.onFailure);
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(params.endpoint.port, params.endpoint.host, () => {
        server.off("error", reject);
        resolve();
      });
    });
  } catch (error) {
    await close();
    throw error;
  }
  return { stopAccepting, close };
}
