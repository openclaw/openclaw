import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { OciNativeClient, OciNativeError, type OciNativeChatRequest } from "./native-client.js";
import { OciRequestSigner } from "./oci-signer.js";
import { loadOciProfile } from "./profile-loader.js";

const FIXED_NOW_MS = Date.UTC(2026, 4, 6, 0, 0, 0);

type CapturedRequest = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
};

async function buildClient(
  responder: (req: CapturedRequest) => { status: number; body: unknown },
): Promise<{ client: OciNativeClient; captured: CapturedRequest[]; cleanup: () => Promise<void> }> {
  const workDir = await mkdtemp(join(tmpdir(), "oci-native-"));
  const keyFile = join(workDir, "key.pem");
  const configFile = join(workDir, "config");

  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  await writeFile(keyFile, privateKey.export({ type: "pkcs8", format: "pem" }));
  await writeFile(
    configFile,
    [
      "[DEFAULT]",
      "user=ocid1.user.oc1..u",
      "tenancy=ocid1.tenancy.oc1..t",
      "fingerprint=ab:cd",
      `key_file=${keyFile}`,
    ].join("\n"),
  );

  const profile = await loadOciProfile({ configFile });
  const signer = new OciRequestSigner({ profile, nowMs: FIXED_NOW_MS });
  const captured: CapturedRequest[] = [];
  const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" || input instanceof URL ? String(input) : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = Object.fromEntries(new Headers(init?.headers as HeadersInit).entries());
    const bodyText = typeof init?.body === "string" ? init.body : "";
    const body = bodyText ? JSON.parse(bodyText) : undefined;
    const req: CapturedRequest = { url, method, headers, body };
    captured.push(req);
    const reply = responder(req);
    return new Response(JSON.stringify(reply.body), {
      status: reply.status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;

  const client = new OciNativeClient({ signer, fetchImpl: fakeFetch });
  return {
    client,
    captured,
    cleanup: () => rm(workDir, { recursive: true, force: true }),
  };
}

describe("OciNativeClient", () => {
  let cleanup: () => Promise<void>;
  afterEach(async () => {
    await cleanup?.();
  });

  describe("Cohere apiFormat", () => {
    it("posts to /20231130/actions/chat with the COHERE-shaped chatRequest", async () => {
      const fixture = await buildClient(() => ({
        status: 200,
        body: {
          chatResponse: {
            text: "Hello from Cohere via OCI.",
            finishReason: "COMPLETE",
          },
          modelResponse: {
            usage: { promptTokens: 10, completionTokens: 8, totalTokens: 18 },
          },
        },
      }));
      cleanup = fixture.cleanup;

      const request: OciNativeChatRequest = {
        region: "us-chicago-1",
        compartmentId: "ocid1.compartment.oc1..xyz",
        modelId: "cohere.command-r-plus-08-2024",
        apiFormat: "COHERE",
        message: "Hello",
        maxTokens: 512,
      };

      const reply = await fixture.client.chat(request);

      expect(fixture.captured).toHaveLength(1);
      const sent = fixture.captured[0];
      expect(sent.url).toBe(
        "https://inference.generativeai.us-chicago-1.oci.oraclecloud.com/20231130/actions/chat",
      );
      expect(sent.method).toBe("POST");
      expect(sent.headers["content-type"]).toBe("application/json");
      expect(sent.headers.authorization).toMatch(/^Signature/);
      expect(sent.body).toMatchObject({
        compartmentId: "ocid1.compartment.oc1..xyz",
        servingMode: {
          modelId: "cohere.command-r-plus-08-2024",
          servingType: "ON_DEMAND",
        },
        chatRequest: {
          apiFormat: "COHERE",
          message: "Hello",
          maxTokens: 512,
        },
      });
      expect(reply.text).toBe("Hello from Cohere via OCI.");
      expect(reply.finishReason).toBe("COMPLETE");
      expect(reply.usage).toEqual({
        inputTokens: 10,
        outputTokens: 8,
        totalTokens: 18,
      });
    });

    it("includes chatHistory only when non-empty", async () => {
      const fixture = await buildClient(() => ({
        status: 200,
        body: {
          chatResponse: { text: "ok", finishReason: "COMPLETE" },
          modelResponse: { usage: {} },
        },
      }));
      cleanup = fixture.cleanup;

      await fixture.client.chat({
        region: "us-chicago-1",
        compartmentId: "ocid1.compartment.oc1..x",
        modelId: "cohere.command-r-plus-08-2024",
        apiFormat: "COHERE",
        message: "Follow-up",
        chatHistory: [
          { role: "USER", message: "Hi" },
          { role: "CHATBOT", message: "Hello back" },
        ],
      });

      const body = fixture.captured[0].body as Record<string, unknown>;
      const chatRequest = body.chatRequest as Record<string, unknown>;
      expect(chatRequest.chatHistory).toEqual([
        { role: "USER", message: "Hi" },
        { role: "CHATBOT", message: "Hello back" },
      ]);
    });

    it("rejects when message is missing", async () => {
      const fixture = await buildClient(() => ({ status: 200, body: {} }));
      cleanup = fixture.cleanup;

      await expect(
        fixture.client.chat({
          region: "us-chicago-1",
          compartmentId: "ocid1.compartment.oc1..x",
          modelId: "cohere.command-r-plus-08-2024",
          apiFormat: "COHERE",
        }),
      ).rejects.toThrow(/message/i);
    });
  });

  describe("Generic apiFormat", () => {
    it("posts a generic message[] payload and parses choices[0].message.content", async () => {
      const fixture = await buildClient(() => ({
        status: 200,
        body: {
          chatResponse: {
            choices: [
              {
                message: { content: [{ type: "TEXT", text: "Generic reply" }] },
                finishReason: "stop",
              },
            ],
          },
          modelResponse: {
            usage: { promptTokens: 4, completionTokens: 3, totalTokens: 7 },
          },
        },
      }));
      cleanup = fixture.cleanup;

      const reply = await fixture.client.chat({
        region: "us-chicago-1",
        compartmentId: "ocid1.compartment.oc1..x",
        modelId: "meta.llama-3.3-70b-instruct",
        apiFormat: "GENERIC",
        messages: [
          { role: "system", content: "Be terse." },
          { role: "user", content: "Say hi." },
        ],
        maxTokens: 32,
      });

      const body = fixture.captured[0].body as Record<string, unknown>;
      const chatRequest = body.chatRequest as Record<string, unknown>;
      expect(chatRequest.apiFormat).toBe("GENERIC");
      expect(chatRequest.messages).toEqual([
        { role: "SYSTEM", content: [{ type: "TEXT", text: "Be terse." }] },
        { role: "USER", content: [{ type: "TEXT", text: "Say hi." }] },
      ]);
      expect(reply.text).toBe("Generic reply");
      expect(reply.finishReason).toBe("stop");
      expect(reply.usage.totalTokens).toBe(7);
    });

    it("rejects when messages[] is missing or empty", async () => {
      const fixture = await buildClient(() => ({ status: 200, body: {} }));
      cleanup = fixture.cleanup;

      await expect(
        fixture.client.chat({
          region: "us-chicago-1",
          compartmentId: "ocid1.compartment.oc1..x",
          modelId: "meta.llama-3.3-70b-instruct",
          apiFormat: "GENERIC",
          messages: [],
        }),
      ).rejects.toThrow(/messages/i);
    });
  });

  describe("error handling", () => {
    it("wraps non-2xx responses in OciNativeError with the status code", async () => {
      const fixture = await buildClient(() => ({
        status: 401,
        body: { code: "NotAuthenticated", message: "Bad key fingerprint" },
      }));
      cleanup = fixture.cleanup;

      const promise = fixture.client.chat({
        region: "us-chicago-1",
        compartmentId: "ocid1.compartment.oc1..x",
        modelId: "cohere.command-r-plus-08-2024",
        apiFormat: "COHERE",
        message: "Hi",
      });

      await expect(promise).rejects.toBeInstanceOf(OciNativeError);
      await expect(promise).rejects.toHaveProperty("status", 401);
    });

    it("merges extras fields into chatRequest", async () => {
      const fixture = await buildClient(() => ({
        status: 200,
        body: { chatResponse: { text: "ok" }, modelResponse: { usage: {} } },
      }));
      cleanup = fixture.cleanup;

      await fixture.client.chat({
        region: "us-chicago-1",
        compartmentId: "ocid1.compartment.oc1..x",
        modelId: "cohere.command-r-plus-08-2024",
        apiFormat: "COHERE",
        message: "Hi",
        extras: { documents: [{ title: "spec", snippet: "..." }] },
      });

      const body = fixture.captured[0].body as Record<string, unknown>;
      const chatRequest = body.chatRequest as Record<string, unknown>;
      expect(chatRequest.documents).toEqual([{ title: "spec", snippet: "..." }]);
    });

    it("respects ON_DEMAND default and DEDICATED override on servingType", async () => {
      const fixture = await buildClient(() => ({
        status: 200,
        body: { chatResponse: { text: "ok" }, modelResponse: { usage: {} } },
      }));
      cleanup = fixture.cleanup;

      await fixture.client.chat({
        region: "us-chicago-1",
        compartmentId: "ocid1.compartment.oc1..x",
        modelId: "cohere.command-r-plus-08-2024",
        apiFormat: "COHERE",
        message: "Hi",
        servingType: "DEDICATED",
      });

      const body = fixture.captured[0].body as Record<string, unknown>;
      const servingMode = body.servingMode as Record<string, unknown>;
      expect(servingMode.servingType).toBe("DEDICATED");
    });
  });
});
