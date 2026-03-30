import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { upsertAuthProfile } from "openclaw/plugin-sdk/provider-auth-api-key";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildOracleRuntimeAuthToken, ORACLE_PROFILE_ID, ORACLE_PROVIDER_ID } from "./oci-auth.js";
import { convertPiMessagesToOracleMessages, createOracleStreamFn } from "./oci-stream.js";

const oracleFixtureDirs: string[] = [];

const ORACLE_RUNTIME_AUTH = buildOracleRuntimeAuthToken({
  configFile: "/tmp/oracle-config",
  profile: "DEFAULT",
  compartmentId: "ocid1.compartment.oc1..test",
  tenancyId: "ocid1.tenancy.oc1..tenant",
});

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

async function collectStreamEvents(stream: ReturnType<ReturnType<typeof createOracleStreamFn>>) {
  const resolved = await Promise.resolve(stream);
  return collectOracleEvents(resolved as AsyncIterable<unknown>);
}

function getDoneEvent(events: unknown[]) {
  const doneEvent = events.find(
    (event) => (event as { type?: unknown } | undefined)?.type === "done",
  );
  expect(doneEvent).toBeDefined();
  return doneEvent as {
    type: "done";
    reason: "stop" | "length" | "toolUse";
    message: {
      stopReason?: string;
      content?: unknown[];
      usage?: { input?: number; output?: number; totalTokens?: number };
    };
  };
}

async function runOracleStream(params: {
  modelId: string;
  messages: unknown[];
  tools?: unknown[];
  systemPrompt?: string;
  response: unknown;
  options?: {
    temperature?: number;
    maxTokens?: number;
    topP?: number;
  };
}) {
  const requests: unknown[] = [];
  const close = vi.fn();
  const chat = vi.fn(async (request: unknown) => {
    requests.push(request);
    return params.response;
  });
  const streamFn = createOracleStreamFn(
    (() =>
      ({
        chat: chat as never,
        close: close as never,
      }) as never) as never,
  );
  const events = await collectStreamEvents(
    streamFn(
      {
        id: params.modelId,
        api: "openai-completions",
        provider: "oracle",
      } as never,
      {
        systemPrompt: params.systemPrompt,
        messages: params.messages,
        tools: params.tools,
      } as never,
      {
        apiKey: ORACLE_RUNTIME_AUTH,
        temperature: params.options?.temperature ?? 0.2,
        maxTokens: params.options?.maxTokens ?? 256,
        topP: params.options?.topP ?? 0.9,
      } as never,
    ),
  );

  expect(chat).toHaveBeenCalledTimes(1);
  expect(close).toHaveBeenCalledTimes(1);
  expect(requests).toHaveLength(1);
  return {
    events,
    request: requests[0] as {
      chatDetails?: {
        chatRequest?: Record<string, unknown>;
      };
    },
  };
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

describe("createOracleStreamFn auth resolution", () => {
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

describe("createOracleStreamFn routing", () => {
  it("uses GENERIC formatting for non-Cohere OCI model families", async () => {
    const genericModelIds = [
      "openai.gpt-5.4",
      "openai.gpt-oss-120b",
      "xai.grok-4.20-reasoning",
      "google.gemini-2.5-flash",
      "meta.llama-4-scout-17b-16e-instruct",
    ];

    for (const modelId of genericModelIds) {
      const { request } = await runOracleStream({
        modelId,
        messages: [{ role: "user", content: "hello" }],
        tools: [
          {
            name: "lookup",
            description: "Look something up",
            parameters: {
              type: "object",
              properties: {
                query: {
                  type: "string",
                  description: "The query text",
                },
              },
              required: ["query"],
            },
          },
        ],
        response: {
          chatResult: {
            modelId,
            chatResponse: {
              apiFormat: "GENERIC",
              choices: [
                {
                  message: {
                    role: "ASSISTANT",
                    content: [{ type: "TEXT", text: "ok" }],
                  },
                  finishReason: "STOP",
                },
              ],
              usage: {
                promptTokens: 2,
                completionTokens: 1,
                totalTokens: 3,
              },
            },
          },
        },
      });

      const chatRequest = request.chatDetails?.chatRequest as {
        apiFormat?: string;
        tools?: Array<{ parameters?: Record<string, unknown> }>;
      };
      expect(chatRequest.apiFormat).toBe("GENERIC");
      expect(chatRequest.tools?.[0]?.parameters).toMatchObject({
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "The query text",
          },
        },
        required: ["query"],
      });
    }
  });

  it("uses COHERE formatting for all current Cohere v1 OCI aliases", async () => {
    const cohereV1ModelIds = [
      "cohere.command-r-08-2024",
      "cohere.command-r-plus-08-2024",
      "cohere.command-latest",
      "cohere.command-plus-latest",
      "cohere.command-r-16k",
      "cohere.command-r-plus",
    ];

    for (const modelId of cohereV1ModelIds) {
      const { request } = await runOracleStream({
        modelId,
        messages: [{ role: "user", content: "hello" }],
        tools: [
          {
            name: "lookup",
            description: "Look something up",
            parameters: {
              type: "object",
              properties: {
                query: {
                  type: "string",
                  description: "The query text",
                },
              },
              required: ["query"],
            },
          },
        ],
        response: {
          chatResult: {
            modelId,
            chatResponse: {
              apiFormat: "COHERE",
              text: "ok",
              finishReason: "COMPLETE",
              usage: {
                promptTokens: 2,
                completionTokens: 1,
                totalTokens: 3,
              },
            },
          },
        },
      });

      const chatRequest = request.chatDetails?.chatRequest as {
        apiFormat?: string;
        tools?: Array<{
          name?: string;
          parameterDefinitions?: Record<string, { type?: string; isRequired?: boolean }>;
        }>;
      };
      expect(chatRequest.apiFormat).toBe("COHERE");
      expect(chatRequest.tools?.[0]).toMatchObject({
        name: "lookup",
        parameterDefinitions: {
          query: {
            type: "str",
            isRequired: true,
          },
        },
      });
    }
  });

  it("uses COHEREV2 formatting for all current Cohere v2 OCI aliases", async () => {
    const cohereV2ModelIds = [
      "cohere.command-a-vision",
      "cohere.command-a-reasoning",
      "cohere.command-a-03-2025",
    ];

    for (const modelId of cohereV2ModelIds) {
      const { request } = await runOracleStream({
        modelId,
        messages: [{ role: "user", content: "hello" }],
        tools: [
          {
            name: "lookup",
            description: "Look something up",
            parameters: {
              type: "object",
              properties: {
                query: {
                  type: "string",
                  description: "The query text",
                },
              },
              required: ["query"],
            },
          },
        ],
        response: {
          chatResult: {
            modelId,
            chatResponse: {
              apiFormat: "COHEREV2",
              message: {
                role: "ASSISTANT",
                content: [{ type: "TEXT", text: "ok" }],
              },
              finishReason: "COMPLETE",
              usage: {
                promptTokens: 2,
                completionTokens: 1,
                totalTokens: 3,
              },
            },
          },
        },
      });

      const chatRequest = request.chatDetails?.chatRequest as {
        apiFormat?: string;
        tools?: Array<{
          type?: string;
          function?: { parameters?: Record<string, unknown> };
        }>;
      };
      expect(chatRequest.apiFormat).toBe("COHEREV2");
      expect(chatRequest.tools?.[0]).toMatchObject({
        type: "FUNCTION",
        function: {
          parameters: {
            type: "object",
            properties: {
              query: {
                type: "string",
                description: "The query text",
              },
            },
            required: ["query"],
          },
        },
      });
    }
  });

  it("uses maxCompletionTokens instead of maxTokens for OCI OpenAI generic models", async () => {
    const { request } = await runOracleStream({
      modelId: "openai.gpt-5.4",
      messages: [{ role: "user", content: "hello" }],
      response: {
        chatResult: {
          modelId: "openai.gpt-5.4",
          chatResponse: {
            apiFormat: "GENERIC",
            choices: [
              {
                message: {
                  role: "ASSISTANT",
                  content: [{ type: "TEXT", text: "ok" }],
                },
                finishReason: "STOP",
              },
            ],
          },
        },
      },
      options: {
        maxTokens: 64,
      },
    });

    const chatRequest = request.chatDetails?.chatRequest as {
      apiFormat?: string;
      maxTokens?: number;
      maxCompletionTokens?: number;
    };
    expect(chatRequest.apiFormat).toBe("GENERIC");
    expect(chatRequest.maxCompletionTokens).toBe(64);
    expect(chatRequest.maxTokens).toBeUndefined();
  });
});

describe("createOracleStreamFn response handling", () => {
  it("maps lowercase generic length finish reasons to length", async () => {
    const { events } = await runOracleStream({
      modelId: "openai.gpt-5.4",
      messages: [{ role: "user", content: "hello" }],
      response: {
        chatResult: {
          modelId: "openai.gpt-5.4",
          chatResponse: {
            apiFormat: "GENERIC",
            choices: [
              {
                message: {
                  role: "ASSISTANT",
                  content: [{ type: "TEXT", text: "truncated" }],
                },
                finishReason: "max_tokens",
                usage: {
                  promptTokens: 3,
                  completionTokens: 5,
                  totalTokens: 8,
                },
              },
            ],
          },
        },
      },
    });

    const doneEvent = getDoneEvent(events);
    expect(doneEvent.reason).toBe("length");
    expect(doneEvent.message.stopReason).toBe("length");
    expect(doneEvent.message.content).toEqual([{ type: "text", text: "truncated" }]);
  });

  it("preserves generic follow-up tool calling request and response handling", async () => {
    const { request, events } = await runOracleStream({
      modelId: "xai.grok-4",
      systemPrompt: "Use tools when needed.",
      messages: [
        { role: "user", content: "Read the file." },
        {
          role: "assistant",
          content: [
            {
              type: "tool_call",
              id: "call_generic",
              name: "read_file",
              arguments: { path: "README.md" },
            },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "call_generic",
          content: [{ type: "text", text: "README contents" }],
        },
      ],
      tools: [
        {
          name: "read_file",
          description: "Read a file",
          parameters: {
            type: "object",
            properties: {
              path: { type: "string" },
            },
            required: ["path"],
          },
        },
      ],
      response: {
        chatResult: {
          modelId: "xai.grok-4",
          chatResponse: {
            apiFormat: "GENERIC",
            choices: [
              {
                message: {
                  role: "ASSISTANT",
                  content: [{ type: "TEXT", text: "Calling another tool." }],
                  toolCalls: [
                    {
                      id: "call_generic_out",
                      type: "FUNCTION",
                      name: "summarize",
                      arguments: '{"path":"README.md"}',
                    },
                  ],
                },
                finishReason: "stop",
                usage: {
                  promptTokens: 12,
                  completionTokens: 4,
                  totalTokens: 16,
                },
              },
            ],
          },
        },
      },
    });

    const chatRequest = request.chatDetails?.chatRequest as {
      apiFormat?: string;
      messages?: Array<Record<string, unknown>>;
    };
    expect(chatRequest.apiFormat).toBe("GENERIC");
    expect(chatRequest.messages).toEqual([
      {
        role: "SYSTEM",
        content: [{ type: "TEXT", text: "Use tools when needed." }],
      },
      {
        role: "USER",
        content: [{ type: "TEXT", text: "Read the file." }],
      },
      {
        role: "ASSISTANT",
        toolCalls: [
          {
            id: "call_generic",
            type: "FUNCTION",
            name: "read_file",
            arguments: '{"path":"README.md"}',
          },
        ],
      },
      {
        role: "TOOL",
        toolCallId: "call_generic",
        content: [{ type: "TEXT", text: "README contents" }],
      },
    ]);

    const doneEvent = getDoneEvent(events);
    expect(doneEvent.reason).toBe("toolUse");
    expect(doneEvent.message.stopReason).toBe("toolUse");
    expect(doneEvent.message.content).toEqual([
      { type: "text", text: "Calling another tool." },
      {
        type: "toolCall",
        id: "call_generic_out",
        name: "summarize",
        arguments: { path: "README.md" },
      },
    ]);
  });

  it("preserves Cohere v1 tool calling request and response handling", async () => {
    const { request, events } = await runOracleStream({
      modelId: "cohere.command-r-08-2024",
      systemPrompt: "Be helpful.",
      messages: [
        { role: "user", content: "Look up alpha." },
        {
          role: "assistant",
          content: [
            {
              type: "function_call",
              id: "call_cohere_v1",
              name: "lookup",
              arguments: { query: "alpha" },
            },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "call_cohere_v1",
          content: [{ type: "text", text: "alpha result" }],
        },
      ],
      tools: [
        {
          name: "lookup",
          description: "Look something up",
          parameters: {
            type: "object",
            properties: {
              query: {
                type: "string",
                description: "The query text",
              },
            },
            required: ["query"],
          },
        },
      ],
      response: {
        chatResult: {
          modelId: "cohere.command-r-08-2024",
          chatResponse: {
            apiFormat: "COHERE",
            text: "Running the lookup tool.",
            toolCalls: [
              {
                name: "lookup",
                parameters: { query: "alpha" },
              },
            ],
            finishReason: "COMPLETE",
            usage: {
              promptTokens: 7,
              completionTokens: 3,
              totalTokens: 10,
            },
          },
        },
      },
    });

    const chatRequest = request.chatDetails?.chatRequest as {
      apiFormat?: string;
      message?: string;
      preambleOverride?: string;
      chatHistory?: Array<Record<string, unknown>>;
      toolResults?: Array<Record<string, unknown>>;
    };
    expect(chatRequest).toMatchObject({
      apiFormat: "COHERE",
      message: "Look up alpha.",
      preambleOverride: "Be helpful.",
      chatHistory: [
        {
          role: "CHATBOT",
          toolCalls: [
            {
              name: "lookup",
              parameters: { query: "alpha" },
            },
          ],
        },
      ],
      toolResults: [
        {
          call: {
            name: "lookup",
            parameters: { query: "alpha" },
          },
          outputs: [{ text: "alpha result" }],
        },
      ],
    });

    const doneEvent = getDoneEvent(events);
    expect(doneEvent.reason).toBe("toolUse");
    expect(doneEvent.message.content).toEqual([
      { type: "text", text: "Running the lookup tool." },
      {
        type: "toolCall",
        id: expect.stringMatching(/^oracle_call_/),
        name: "lookup",
        arguments: { query: "alpha" },
      },
    ]);
  });

  it("preserves Cohere v2 tool calling request and response handling", async () => {
    const { request, events } = await runOracleStream({
      modelId: "cohere.command-a-03-2025",
      systemPrompt: "Use tools when useful.",
      messages: [
        { role: "user", content: "Look up beta." },
        {
          role: "assistant",
          content: [
            {
              type: "function_call",
              id: "call_cohere_v2",
              name: "lookup",
              arguments: { query: "beta" },
            },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "call_cohere_v2",
          content: [{ type: "text", text: "beta result" }],
        },
      ],
      tools: [
        {
          name: "lookup",
          description: "Look something up",
          parameters: {
            type: "object",
            properties: {
              query: {
                type: "string",
                description: "The query text",
              },
            },
            required: ["query"],
          },
        },
      ],
      response: {
        chatResult: {
          modelId: "cohere.command-a-03-2025",
          chatResponse: {
            apiFormat: "COHEREV2",
            message: {
              role: "ASSISTANT",
              content: [{ type: "TEXT", text: "Running the lookup tool." }],
              toolCalls: [
                {
                  id: "call_cohere_v2_out",
                  type: "FUNCTION",
                  function: {
                    name: "lookup",
                    arguments: '{"query":"beta"}',
                  },
                },
              ],
            },
            finishReason: "TOOL_CALL",
            usage: {
              promptTokens: 8,
              completionTokens: 3,
              totalTokens: 11,
            },
          },
        },
      },
    });

    const chatRequest = request.chatDetails?.chatRequest as {
      apiFormat?: string;
      messages?: Array<Record<string, unknown>>;
    };
    expect(chatRequest).toMatchObject({
      apiFormat: "COHEREV2",
      messages: [
        {
          role: "SYSTEM",
          content: [{ type: "TEXT", text: "Use tools when useful." }],
        },
        {
          role: "USER",
          content: [{ type: "TEXT", text: "Look up beta." }],
        },
        {
          role: "ASSISTANT",
          content: [],
          toolCalls: [
            {
              id: "call_cohere_v2",
              type: "FUNCTION",
              function: {
                name: "lookup",
                arguments: '{"query":"beta"}',
              },
            },
          ],
        },
        {
          role: "TOOL",
          toolCallId: "call_cohere_v2",
          content: [{ type: "TEXT", text: "beta result" }],
        },
      ],
    });

    const doneEvent = getDoneEvent(events);
    expect(doneEvent.reason).toBe("toolUse");
    expect(doneEvent.message.content).toEqual([
      { type: "text", text: "Running the lookup tool." },
      {
        type: "toolCall",
        id: "call_cohere_v2_out",
        name: "lookup",
        arguments: { query: "beta" },
      },
    ]);
  });
});
