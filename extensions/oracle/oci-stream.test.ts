import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { upsertAuthProfile } from "openclaw/plugin-sdk/provider-auth-api-key";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ORACLE_PROFILE_ID, ORACLE_PROVIDER_ID } from "./oci-auth.js";
import { createOracleStreamFn, convertPiMessagesToOracleMessages } from "./oci-stream.js";

const oracleFixtureDirs: string[] = [];

function writeOracleFixture(): {
  agentDir: string;
  configFile: string;
  profile: string;
  compartmentId: string;
  tenancyId: string;
} {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-oracle-"));
  oracleFixtureDirs.push(dir);

  const agentDir = path.join(dir, "agent");
  const configFile = path.join(dir, "config");
  const keyFile = path.join(dir, "oci_api_key.pem");
  const profile = "DEFAULT";
  const compartmentId = "ocid1.compartment.oc1..examplecompartment";
  const tenancyId = "ocid1.tenancy.oc1..exampletenancy";

  fs.writeFileSync(
    keyFile,
    [
      "-----BEGIN PRIVATE KEY-----",
      "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQD",
      "-----END PRIVATE KEY-----",
      "",
    ].join("\n"),
    "utf8",
  );
  fs.writeFileSync(
    configFile,
    [
      `[${profile}]`,
      "user=ocid1.user.oc1..exampleuser",
      "fingerprint=11:22:33:44:55:66:77:88:99:aa:bb:cc:dd:ee:ff:00",
      "key_file=./oci_api_key.pem",
      `tenancy=${tenancyId}`,
      "region=us-chicago-1",
      "",
    ].join("\n"),
    "utf8",
  );

  upsertAuthProfile({
    agentDir,
    profileId: ORACLE_PROFILE_ID,
    credential: {
      type: "api_key",
      provider: ORACLE_PROVIDER_ID,
      key: configFile,
      metadata: {
        profile,
        compartmentId,
        tenancyId,
      },
    },
  });

  return {
    agentDir,
    configFile,
    profile,
    compartmentId,
    tenancyId,
  };
}

async function collectOracleEvents(stream: AsyncIterable<unknown>) {
  const events: unknown[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

afterEach(() => {
  for (const dir of oracleFixtureDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  delete process.env.OCI_CONFIG_FILE;
  delete process.env.OCI_PROFILE;
  delete process.env.OCI_CLI_PROFILE;
  delete process.env.OCI_COMPARTMENT_ID;
});

describe("convertPiMessagesToOracleMessages", () => {
  it("pairs Gemini tool calls with tool results when the model ref is family-detectable", () => {
    const oracleMessages = convertPiMessagesToOracleMessages({
      modelId: "google.gemini-2.5-pro",
      messages: [
        {
          role: "user",
          content: "Use tools",
        },
        {
          role: "assistant",
          content: [
            { type: "text", text: "Working on it" },
            { type: "toolCall", id: "call_1", name: "toolOne", arguments: { a: 1 } },
            { type: "toolCall", id: "call_2", name: "toolTwo", arguments: { b: 2 } },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "call_1",
          content: [{ type: "text", text: "first result" }],
        },
        {
          role: "toolResult",
          toolCallId: "call_2",
          content: [{ type: "text", text: "second result" }],
        },
      ] as never,
    });

    expect(oracleMessages).toEqual([
      {
        role: "USER",
        content: [{ type: "TEXT", text: "Use tools" }],
      },
      {
        role: "ASSISTANT",
        content: [{ type: "TEXT", text: "Working on it" }],
        toolCalls: [{ id: "call_1", type: "FUNCTION", name: "toolOne", arguments: '{"a":1}' }],
      },
      {
        role: "TOOL",
        toolCallId: "call_1",
        content: [{ type: "TEXT", text: "first result" }],
      },
      {
        role: "ASSISTANT",
        toolCalls: [{ id: "call_2", type: "FUNCTION", name: "toolTwo", arguments: '{"b":2}' }],
      },
      {
        role: "TOOL",
        toolCallId: "call_2",
        content: [{ type: "TEXT", text: "second result" }],
      },
    ]);
  });

  it("leaves opaque OCI ids on the generic tool-call path", () => {
    const oracleMessages = convertPiMessagesToOracleMessages({
      modelId: "ocid1.model.oc1..opaquegeminiid",
      messages: [
        {
          role: "assistant",
          content: [
            { type: "toolCall", id: "call_1", name: "toolOne", arguments: { a: 1 } },
            { type: "toolCall", id: "call_2", name: "toolTwo", arguments: { b: 2 } },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "call_1",
          content: [{ type: "text", text: "first result" }],
        },
        {
          role: "toolResult",
          toolCallId: "call_2",
          content: [{ type: "text", text: "second result" }],
        },
      ] as never,
    });

    expect(oracleMessages).toEqual([
      {
        role: "ASSISTANT",
        toolCalls: [
          { id: "call_1", type: "FUNCTION", name: "toolOne", arguments: '{"a":1}' },
          { id: "call_2", type: "FUNCTION", name: "toolTwo", arguments: '{"b":2}' },
        ],
      },
      {
        role: "TOOL",
        toolCallId: "call_1",
        content: [{ type: "TEXT", text: "first result" }],
      },
      {
        role: "TOOL",
        toolCallId: "call_2",
        content: [{ type: "TEXT", text: "second result" }],
      },
    ]);
  });
});

describe("createOracleStreamFn", () => {
  it("uses the stored Oracle profile when runtime auth token is absent", async () => {
    const fixture = writeOracleFixture();

    const chat = vi.fn(async () => ({
      chatResult: {
        chatResponse: {
          choices: [
            {
              message: {
                content: [{ type: "TEXT", text: "Oracle says hi" }],
              },
              finishReason: "STOP",
            },
          ],
        },
      },
    }));
    const close = vi.fn();
    const createClient = vi.fn((auth: unknown) => {
      expect(auth).toEqual({
        configFile: fixture.configFile,
        profile: fixture.profile,
        compartmentId: fixture.compartmentId,
        tenancyId: fixture.tenancyId,
      });
      return { chat, close } as never;
    });

    const streamFn = createOracleStreamFn({
      agentDir: fixture.agentDir,
      createClient: createClient as never,
    });
    const stream = await streamFn(
      {
        api: "openai-completions",
        provider: "oracle",
        id: "google.gemini-2.5-pro",
      } as never,
      {
        messages: [{ role: "user", content: "Hello OCI" }],
        tools: [],
      } as never,
      undefined,
    );
    const events = await collectOracleEvents(stream);

    expect(createClient).toHaveBeenCalledOnce();
    expect(chat).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "done",
        reason: "stop",
      }),
    );
  });

  it("keeps the stored Oracle profile metadata when the caller passes the source config path", async () => {
    const fixture = writeOracleFixture();

    const chat = vi.fn(async () => ({
      chatResult: {
        chatResponse: {
          choices: [
            {
              message: {
                content: [{ type: "TEXT", text: "Source auth path works" }],
              },
              finishReason: "STOP",
            },
          ],
        },
      },
    }));
    const close = vi.fn();
    const createClient = vi.fn((auth: unknown) => {
      expect(auth).toEqual({
        configFile: fixture.configFile,
        profile: fixture.profile,
        compartmentId: fixture.compartmentId,
        tenancyId: fixture.tenancyId,
      });
      return { chat, close } as never;
    });

    const streamFn = createOracleStreamFn({
      agentDir: fixture.agentDir,
      createClient: createClient as never,
    });
    const stream = await streamFn(
      {
        api: "openai-completions",
        provider: "oracle",
        id: "meta.llama-3.3-70b-instruct",
      } as never,
      {
        messages: [{ role: "user", content: "Hello OCI" }],
        tools: [],
      } as never,
      {
        apiKey: fixture.configFile,
      } as never,
    );
    const events = await collectOracleEvents(stream);

    expect(createClient).toHaveBeenCalledOnce();
    expect(chat).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "done",
        reason: "stop",
      }),
    );
  });
});
