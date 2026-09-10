import { estimateStringChars } from "@openclaw/normalization-core/cjk-chars";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { describe, expect, it, vi } from "vitest";
import type { AgentMessage } from "../../packages/agent-core/src/types.js";
import * as loggingConfig from "../logging/config.js";
import { buildExecAutoReviewTranscript } from "./exec-auto-review-transcript.js";
import { castAgentMessage } from "./test-helpers/agent-message-fixtures.js";

const user = (content: string, metadata: Record<string, unknown> = {}): AgentMessage =>
  castAgentMessage({ role: "user", content, timestamp: 0, ...metadata });
const assistant = (text: string): AgentMessage =>
  castAgentMessage({ role: "assistant", content: [{ type: "text", text }] });
const call = (id: string, args: Record<string, unknown> = {}): AgentMessage =>
  castAgentMessage({
    role: "assistant",
    content: [{ type: "toolCall", id, name: "exec", arguments: args }],
  });
const result = (id: string, text: string): AgentMessage =>
  castAgentMessage({
    role: "toolResult",
    toolCallId: id,
    toolName: "exec",
    content: [{ type: "text", text }],
  });

describe("buildExecAutoReviewTranscript", () => {
  it("projects chronological text and paired tool activity without thinking, media, details, or identity metadata", () => {
    const secret = "sk-abcdef1234567890xyz";
    const transcript = buildExecAutoReviewTranscript({
      messages: [
        user(`Build the project; key=${secret}`, {
          __openclaw: { senderId: "private-peer", senderIsOwner: true },
        }),
        castAgentMessage({
          role: "assistant",
          content: [
            { type: "thinking", thinking: "private reasoning" },
            { type: "text", text: "Checking the build directory." },
          ],
        }),
        call("build-1", {
          command: "ls dist",
          data: "build instructions",
          api_key: secret,
          image: { data: "private-base64" },
          blob: "private-blob",
          b64_json: "private-generated-image",
          file_data: "private-file",
          input_audio: { data: "private-audio", format: "wav" },
          details: { huge: "private-details" },
          sessionKey: "private-session",
          profileId: "private-profile",
        }),
        castAgentMessage({
          role: "toolResult",
          toolCallId: "build-1",
          toolName: "exec",
          content: [
            { type: "text", text: "dist exists" },
            { type: "image", data: "private-result-image", mimeType: "image/png" },
          ],
          details: { huge: "private-result-details" },
        }),
        user("Continue"),
      ],
    });
    expect(transcript.entries.map((entry) => entry.kind)).toEqual([
      "user",
      "assistant",
      "tool_call",
      "tool_result",
      "user",
    ]);
    expect(transcript.entries[0]).toMatchObject({ origin: "operator" });
    expect(transcript.entries[2]).toMatchObject({
      toolName: "exec",
      toolCallId: expect.any(String),
    });
    expect(transcript.entries[2]?.toolCallId).toBe(transcript.entries[3]?.toolCallId);
    expect(transcript.entries[2]?.toolCallId).not.toBe("build-1");
    expect(JSON.parse(expectDefined(transcript.entries[2], "tool call entry").text)).toEqual({
      command: "ls dist",
      data: "build instructions",
      api_key: expect.any(String),
    });
    expect(expectDefined(transcript.entries[3], "tool result entry").text).toBe("dist exists");
    expect(transcript).toMatchObject({ omittedEntries: 0, truncated: false });
    const serialized = JSON.stringify(transcript);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("private-");
    expect(serialized).not.toContain("private reasoning");
  });

  it("applies the active attempt's redaction patterns independently of ambient logging", () => {
    const ambient = vi.spyOn(loggingConfig, "readLoggingConfig").mockReturnValue({
      redactPatterns: ["ambient-private-marker"],
    });
    try {
      const messages = [
        user("Inspect tenant-private-marker"),
        call("inspect", {
          command: "inspect tenant-private-marker",
        }),
        result("inspect", "Result: tenant-private-marker"),
      ];
      expect(JSON.stringify(buildExecAutoReviewTranscript({ messages }))).toContain(
        "tenant-private-marker",
      );
      const input = {
        messages,
        config: { logging: { redactPatterns: ["tenant-private-marker"] } },
      };
      const transcript = buildExecAutoReviewTranscript(input);
      expect(transcript.entries).toHaveLength(3);
      expect(JSON.stringify(transcript)).not.toContain("tenant-private-marker");
    } finally {
      ambient.mockRestore();
    }
  });

  it.each([
    [{ __openclaw: { senderIsOwner: true } }, "operator"],
    [{ __openclaw: { senderIdentity: { type: "profile", id: "private-profile" } } }, "operator"],
    [
      {
        __openclaw: {
          senderIdentity: {
            type: "observation",
            id: "private-peer",
            pluginId: "discord",
            accountId: null,
            senderKind: "human",
          },
        },
      },
      "channel",
    ],
    [
      {
        provenance: { kind: "inter_session", sourceSessionKey: "private-session" },
        __openclaw: { senderIsOwner: true },
      },
      "inter_session",
    ],
    [
      { provenance: { kind: "internal_system" }, __openclaw: { senderIsOwner: true } },
      "internal_system",
    ],
    [{ provenance: { kind: "external_user" } }, "unknown"],
    [{}, "unknown"],
  ] as const)("labels origin from producer metadata: %j", (metadata, origin) => {
    const transcript = buildExecAutoReviewTranscript({ messages: [user("Request", metadata)] });
    expect(transcript.entries).toEqual([{ kind: "user", text: "Request", origin }]);
    expect(JSON.stringify(transcript)).not.toContain("private-");
  });

  it("removes source identifiers repeated in user text and honors a smaller bounded excerpt", () => {
    const transcript = buildExecAutoReviewTranscript({
      messages: [
        user("[sourceSession=private-session] private-peer: please build", {
          provenance: { kind: "inter_session", sourceSessionKey: "private-session" },
          __openclaw: { senderId: "private-peer" },
        }),
        user("Latest request"),
      ],
      limits: { totalChars: 256 },
    });
    expect(transcript.entries).toHaveLength(2);
    expect(JSON.stringify(transcript)).not.toContain("private-");
    expect(JSON.stringify(transcript).length).toBeLessThanOrEqual(256);
  });

  it("scrubs known source identifiers when later users, assistants, and tools repeat them", () => {
    const peerId = 'private"\\peer';
    const transcript = buildExecAutoReviewTranscript({
      messages: [
        user("Please inspect the build", {
          __openclaw: {
            senderId: peerId,
            senderIdentity: { type: "profile", id: "private-profile" },
          },
          provenance: { kind: "inter_session", sourceSessionKey: "private-session" },
        }),
        assistant("I will inspect private-profile"),
        call(peerId, { command: "inspect private-session", data: peerId }),
        result(peerId, `Output for ${peerId}`),
        user(`Continue for ${peerId}, private-profile, and private-session`),
      ],
    });
    expect(transcript.entries).toHaveLength(5);
    expect(JSON.stringify(transcript)).not.toContain("private");
    expect(JSON.parse(expectDefined(transcript.entries[2], "tool call entry").text).data).toBe(
      "[identity omitted]",
    );
    expect(expectDefined(transcript.entries[2], "tool call entry").toolCallId).toBe(
      expectDefined(transcript.entries[3], "tool result entry").toolCallId,
    );
  });

  it("uses original registered user text and provenance instead of hook-rewritten model text", () => {
    const runtime = user("Hook-added instructions");
    const original = user("Please rebuild dist", { __openclaw: { senderIsOwner: true } });
    expect(
      buildExecAutoReviewTranscript({
        messages: [runtime],
        userTurnOrigins: new Map([[runtime, original]]),
      }).entries,
    ).toEqual([{ kind: "user", text: "Please rebuild dist", origin: "operator" }]);
  });

  it("keeps first and latest requests and recent complete tool pairs under the non-user cap", () => {
    const messages = [user("Original request")];
    for (let index = 0; index < 30; index++) {
      messages.push(call(`call-${index}`), result(`call-${index}`, `result-${index}`));
    }
    messages.splice(11, 0, user("Latest request"));
    const transcript = buildExecAutoReviewTranscript({ messages });
    expect(
      transcript.entries.filter((entry) => entry.kind === "user").map((entry) => entry.text),
    ).toEqual(["Original request", "Latest request"]);
    expect(transcript.entries.filter((entry) => entry.kind !== "user")).toHaveLength(40);
    const calls = transcript.entries.filter((entry) => entry.kind === "tool_call");
    const results = transcript.entries.filter((entry) => entry.kind === "tool_result");
    expect(calls.map((entry) => entry.toolCallId)).toEqual(
      results.map((entry) => entry.toolCallId),
    );
    expect(new Set(calls.map((entry) => entry.toolCallId)).size).toBe(20);
    expect(results.map((entry) => entry.text)).toEqual(
      Array.from({ length: 20 }, (_, index) => `result-${index + 10}`),
    );
    expect(transcript).toMatchObject({ omittedEntries: 20, truncated: true });
  });

  it("bounds individual entries without splitting surrogate pairs", () => {
    const transcript = buildExecAutoReviewTranscript({
      messages: [
        user(`${"u".repeat(3_999)}😀tail`),
        assistant("a".repeat(4_001)),
        call("long", { command: "x".repeat(1_100) }),
        result("long", `${"r".repeat(999)}😀tail`),
      ],
    });
    expect(transcript.entries.map((entry) => entry.text.length)).toEqual([
      3_999, 4_000, 1_000, 999,
    ]);
    expect(transcript.entries.every((entry) => entry.truncated)).toBe(true);
    expect(transcript.omittedEntries).toBe(0);
    expect(transcript.truncated).toBe(true);
  });

  it.each(["a", "界", "\u0000"])(
    "keeps user anchors and accounts for serialized %j costs under total pressure",
    (character) => {
      const messages = [
        user(`first ${character.repeat(4_000)}`),
        ...Array.from({ length: 30 }, (_, index) =>
          assistant(`${index} ${character.repeat(4_000)}`),
        ),
        user(`latest ${character.repeat(4_000)}`),
      ];
      const transcript = buildExecAutoReviewTranscript({ messages });
      expect(expectDefined(transcript.entries[0], "first user entry").text).toMatch(/^first /);
      expect(transcript.entries.at(-1)?.text).toMatch(/^latest /);
      expect(JSON.stringify(transcript).length).toBeLessThanOrEqual(24_000);
      expect(estimateStringChars(JSON.stringify(transcript))).toBeLessThanOrEqual(24_000);
      expect(transcript.omittedEntries).toBe(messages.length - transcript.entries.length);
      expect(transcript.omittedEntries).toBeGreaterThan(0);
      expect(transcript.truncated).toBe(true);
    },
  );

  it.each([
    "data:image/png;base64,aGVsbG8=",
    "data:image/png;charset=utf-8;base64,aGVsbG8=",
    "data:image/svg+xml;charset=utf-8,%3Csvg%2F%3E",
    "data:;base64,aGVsbG8=",
  ])("omits embedded data URLs (%s) and structured binary payloads", (dataUrl) => {
    const transcript = buildExecAutoReviewTranscript({
      messages: [
        user(`Look at ${dataUrl} for this build`),
        castAgentMessage({
          role: "toolResult",
          toolCallId: "image",
          toolName: "image",
          content: [
            {
              type: "text",
              text: JSON.stringify({
                text: "Image generated",
                base64: "private-payload",
                details: { private: true },
                resource: { blob: "private-resource", mimeType: "application/pdf" },
              }),
            },
            { type: "text", text: "Done" },
          ],
        }),
      ],
    });
    expect(transcript.entries.map((entry) => entry.text)).toEqual([
      "Look at [media omitted] for this build",
      '{"text":"Image generated","resource":{"mimeType":"application/pdf"}}\nDone',
    ]);
  });

  it.each([
    ["OpenAI file input", { type: "input_file", file_data: "private-payload" }],
    ["Gemini inline data", { inlineData: { mimeType: "image/png", data: "private-payload" } }],
    [
      "Gemini REST inline data",
      { inline_data: { mime_type: "image/png", data: "private-payload" } },
    ],
    ["generated media bytes", { imageBytes: "private-payload", videoBytes: "private-payload" }],
    ["encoded artifact data", { encoding: "base64", data: "private-payload" }],
    ["encoded bundle content", { encoding: "base64", content: "private-payload" }],
    ["MIME-tagged data", { mimeType: "image/png", data: "private-payload" }],
    ["MIME-tagged attachment", { mimeType: "application/pdf", content: "private-payload" }],
  ] satisfies Array<[string, Record<string, unknown>]>)(
    "omits %s from tool arguments and structured results",
    (_label, payload) => {
      const transcript = buildExecAutoReviewTranscript({
        messages: [
          user("Inspect the attachment"),
          call("attachment", payload),
          result("attachment", JSON.stringify(payload)),
        ],
      });
      expect(transcript.entries.map((entry) => entry.kind)).toEqual([
        "user",
        "tool_call",
        "tool_result",
      ]);
      expect(transcript.entries[0]?.text).toBe("Inspect the attachment");
      expect(JSON.stringify(transcript)).not.toContain("private-payload");
    },
  );

  it("omits whole structured data URLs and base64 source blocks before formatting arguments", () => {
    const transcript = buildExecAutoReviewTranscript({
      messages: [
        call("media", {
          uri: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg">private-image</svg>',
          source: { type: "base64", media_type: "application/pdf", data: "private-pdf" },
          label: "Build diagram",
        }),
        call("root-media", { type: "image", data: "private-image" }),
        call("root-audio", { type: "input_audio", data: "private-audio", format: "wav" }),
      ],
    });
    expect(JSON.parse(expectDefined(transcript.entries[0], "tool call entry").text)).toEqual({
      uri: "[media omitted]",
      label: "Build diagram",
    });
    expect(transcript.entries[1]?.text).toBe("[media omitted]");
    expect(transcript.entries[2]?.text).toBe("[media omitted]");
  });
});
