import crypto from "node:crypto";
import { expectDefined } from "@openclaw/normalization-core";
import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createAnthropicPayloadLogger } from "./anthropic-payload-log.js";
import * as queuedFileWriter from "./queued-file-writer.js";

const capturedLines: string[] = [];

beforeEach(() => {
  capturedLines.length = 0;
  vi.spyOn(queuedFileWriter, "getQueuedFileWriter").mockImplementation(() => ({
    filePath: "memory",
    write: (line) => capturedLines.push(line),
    flush: async () => undefined,
  }));
  vi.stubEnv("OPENCLAW_ANTHROPIC_PAYLOAD_LOG", "1");
  vi.stubEnv("OPENCLAW_ANTHROPIC_PAYLOAD_LOG_FILE", undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const bareAnthropicKey = "sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWx"; // pragma: allowlist secret
const bareGithubKey = "ghp_AbCdEfGhIjKlMnOpQrStUvWxYz1234567890"; // pragma: allowlist secret
const bareGoogleKey = "AIzaSyA1bC2dE3fG4hI5jK6lM7nO8pQrStUvW"; // pragma: allowlist secret
const credentialFields = ['"authorization"', '"api_key"', '"nestedToken"'];

it.each(["dashboard", "subagent", "internal-session-effects"])("keeps %s private", (surface) => {
  const logger = createAnthropicPayloadLogger({
    sessionKey: `agent:main:${surface}:incognito-private`,
  });
  logger?.recordUsage([], new Error("synthetic private provider error"));
  expect(capturedLines).toEqual([]);
  expect(logger).toBeNull();
});

it("sanitizes credential fields and image base64 payload data before writing logs", async () => {
  const logger = expectDefined(createAnthropicPayloadLogger({}), "payload logger");
  const source = { type: "base64", media_type: "image/png", data: "QUJDRA==" };
  const payload = {
    messages: [
      {
        role: "user",
        authorization: "Bearer sk-secret", // pragma: allowlist secret
        diagnosticText: bareAnthropicKey,
        content: [{ type: "image", source }],
      },
    ],
    metadata: {
      api_key: "sk-test", // pragma: allowlist secret
      nestedToken: "shh", // pragma: allowlist secret
      tokenBudget: 1024,
      diagnosticText: bareGithubKey,
    },
  };
  const streamFn: StreamFn = (model, __, options) => {
    options?.onPayload?.(payload, model);
    return {} as never;
  };

  const wrapped = logger.wrapStreamFn(streamFn);
  expect(typeof wrapped).toBe("function");
  await wrapped({ api: "anthropic-messages" } as never, { messages: [] } as never, {});

  const event = JSON.parse(capturedLines[0]?.trim() ?? "{}") as {
    payload: typeof payload;
    payloadDigest: string;
  };
  const { payload: logged, payloadDigest } = event;
  const message = expectDefined(logged.messages[0], "logged message");
  expect(message).toMatchObject({ diagnosticText: expect.any(String) });
  expect(message.content[0]?.source).toMatchObject({
    data: "<redacted>",
    bytes: 4,
    sha256: crypto.createHash("sha256").update(source.data).digest("hex"),
  });
  expect(logged.metadata).toMatchObject({ tokenBudget: 1024, diagnosticText: expect.any(String) });
  expect(payloadDigest).toMatch(/^[a-f0-9]{64}$/u);
  const serialized = JSON.stringify(event);
  for (const secret of [bareAnthropicKey, bareGithubKey, ...credentialFields]) {
    expect(serialized).not.toContain(secret);
  }
});

it("sanitizes usage and error fields before writing logs", () => {
  const logger = createAnthropicPayloadLogger({});
  const usage = {
    input: 1,
    authorization: "Bearer sk-secret", // pragma: allowlist secret
    diagnosticText: bareGithubKey,
  };
  logger?.recordUsage(
    [{ role: "assistant", content: "", usage } as never],
    new Error(`failed with Bearer sk-secret and ${bareGoogleKey}`), // pragma: allowlist secret
  );

  const event = JSON.parse(capturedLines[0]?.trim() ?? "{}") as Record<string, unknown>;
  expect(event).toMatchObject({
    error: expect.stringContaining("failed with Bearer <redacted> and "),
  });
  expect(event.usage).toEqual({ input: 1, diagnosticText: expect.any(String) });
  const serialized = JSON.stringify(event);
  expect(serialized).not.toContain(bareGithubKey);
  expect(serialized).not.toContain(bareGoogleKey);
});
