// Real-transport regression proof for Twilio error redaction. The loopback
// server reflects the production Basic auth header in its response body.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { sendSmsViaTwilio } from "./twilio.js";
import type { ResolvedSmsAccount } from "./types.js";

type TwilioError = Error & {
  httpStatus: number;
  responseText: string;
  twilioCode?: number;
};

const servers: Server[] = [];

function createAccount(): ResolvedSmsAccount {
  return {
    accountId: "default",
    enabled: true,
    accountSid: "AC_TEST",
    authToken: "test-auth-token",
    fromNumber: "+15557654321",
    messagingServiceSid: "",
    defaultTo: "",
    webhookPath: "/webhooks/sms",
    publicWebhookUrl: "https://gateway.example.com/webhooks/sms",
    dangerouslyDisableSignatureValidation: false,
    dmPolicy: "pairing",
    allowFrom: [],
    textChunkLimit: 1500,
  };
}

async function startServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<string> {
  const server = createServer((req, res) => {
    void (async () => {
      await new Promise<void>((resolve) => {
        req.resume();
        req.on("end", resolve);
      });
      handler(req, res);
    })();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  servers.push(server);
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function sendAgainst(baseUrl: string): Promise<TwilioError> {
  try {
    await sendSmsViaTwilio({
      account: createAccount(),
      to: "+15551234567",
      text: "hello",
      fetchImpl: (_input, init) => fetch(`${baseUrl}/Messages.json`, init),
    });
  } catch (error) {
    return error as TwilioError;
  }
  throw new Error("Expected Twilio send to fail.");
}

describe("Twilio error redaction real transport", () => {
  afterEach(async () => {
    await Promise.all(servers.splice(0).map(closeServer));
  });

  it("redacts reflected Basic auth from the message and response body", async () => {
    let authorization = "";
    const baseUrl = await startServer((req, res) => {
      authorization = req.headers.authorization ?? "";
      res.writeHead(502, { "content-type": "text/plain" });
      res.end(`proxy failure; Authorization: ${authorization}`);
    });

    const error = await sendAgainst(baseUrl);
    const encodedCredential = Buffer.from("AC_TEST:test-auth-token").toString("base64");

    expect(authorization).toBe(`Basic ${encodedCredential}`);
    expect(error).toMatchObject({
      name: "TwilioSmsApiError",
      httpStatus: 502,
      message: "Twilio SMS send failed (502): proxy failure; Authorization: Basic ***",
      responseText: "proxy failure; Authorization: Basic ***",
      twilioCode: undefined,
    });
    expect(error.message).not.toContain(encodedCredential);
    expect(error.responseText).not.toContain(encodedCredential);
    const credentialAbsent =
      !error.message.includes(encodedCredential) && !error.responseText.includes(encodedCredential);
    console.info(
      "TWILIO_REDACTION_PROOF",
      JSON.stringify({
        transport: "loopback-http",
        authorizationHeaderBuilt: authorization === `Basic ${encodedCredential}`,
        message: error.message,
        responseText: error.responseText,
        credentialAbsent,
        token: "[redacted]",
      }),
    );
  });

  it("preserves ordinary structured Twilio error details", async () => {
    const body = JSON.stringify({ code: 21610, message: "Twilio validation failed." });
    const baseUrl = await startServer((_req, res) => {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(body);
    });

    const error = await sendAgainst(baseUrl);

    expect(error).toMatchObject({
      name: "TwilioSmsApiError",
      httpStatus: 400,
      message: "Twilio SMS send failed (400): Twilio validation failed.",
      responseText: body,
      twilioCode: 21610,
    });
    console.info(
      "TWILIO_REDACTION_CONTROL",
      JSON.stringify({
        httpStatus: error.httpStatus,
        message: error.message,
        responseText: error.responseText,
        twilioCode: error.twilioCode,
      }),
    );
  });
});
