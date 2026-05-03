import crypto from "node:crypto";
import type { StreamFn } from "@mariozechner/pi-agent-core";
import { describe, expect, it } from "vitest";
import { resolveUserPath } from "../utils.js";
import { createAnthropicPayloadLogger, resolvePayloadLogConfig } from "./anthropic-payload-log.js";
import {
  DEFAULT_ANTHROPIC_PAYLOAD_LOG_MAX_ARCHIVES,
  DEFAULT_ANTHROPIC_PAYLOAD_LOG_MAX_FILE_BYTES,
  MAX_DIAGNOSTIC_JSONL_ARCHIVES,
} from "./diagnostic-jsonl-rotation.js";

describe("createAnthropicPayloadLogger", () => {
  it("resolves config-backed defaults and env-overridden rotation settings", () => {
    const configured = resolvePayloadLogConfig({
      cfg: {
        diagnostics: {
          anthropicPayloadLog: {
            enabled: true,
            filePath: "~/.openclaw/logs/provider-payload.jsonl",
          },
        },
      },
      env: {},
    });

    expect(configured.enabled).toBe(true);
    expect(configured.filePath).toBe(resolveUserPath("~/.openclaw/logs/provider-payload.jsonl"));
    expect(configured.maxFileBytes).toBe(DEFAULT_ANTHROPIC_PAYLOAD_LOG_MAX_FILE_BYTES);
    expect(configured.maxArchives).toBe(DEFAULT_ANTHROPIC_PAYLOAD_LOG_MAX_ARCHIVES);

    const overridden = resolvePayloadLogConfig({
      cfg: {
        diagnostics: {
          anthropicPayloadLog: {
            enabled: true,
            maxFileBytes: 1024,
            maxArchives: 1,
          },
        },
      },
      env: {
        OPENCLAW_ANTHROPIC_PAYLOAD_LOG: "0",
        OPENCLAW_ANTHROPIC_PAYLOAD_LOG_MAX_BYTES: "0",
        OPENCLAW_ANTHROPIC_PAYLOAD_LOG_MAX_ARCHIVES: "2",
      },
    });

    expect(overridden.enabled).toBe(false);
    expect(overridden.maxFileBytes).toBeUndefined();
    expect(overridden.maxArchives).toBe(2);
  });

  it("clamps excessive provider payload archive env overrides", () => {
    const cfg = resolvePayloadLogConfig({
      cfg: {
        diagnostics: {
          anthropicPayloadLog: {
            enabled: true,
          },
        },
      },
      env: {
        OPENCLAW_ANTHROPIC_PAYLOAD_LOG_MAX_ARCHIVES: "1000000",
      },
    });

    expect(cfg.maxArchives).toBe(MAX_DIAGNOSTIC_JSONL_ARCHIVES);
  });

  it("sanitizes credential fields and image base64 payload data before writing logs", async () => {
    const lines: string[] = [];
    const logger = createAnthropicPayloadLogger({
      env: { OPENCLAW_ANTHROPIC_PAYLOAD_LOG: "1" },
      writer: {
        filePath: "memory",
        write: (line) => lines.push(line),
        flush: async () => undefined,
      },
    });
    expect(logger).not.toBeNull();

    const payload = {
      messages: [
        {
          role: "user",
          authorization: "Bearer sk-secret", // pragma: allowlist secret
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: "image/png", data: "QUJDRA==" },
            },
          ],
        },
      ],
      metadata: {
        api_key: "sk-test", // pragma: allowlist secret
        nestedToken: "shh", // pragma: allowlist secret
        tokenBudget: 1024,
      },
    };
    const streamFn: StreamFn = ((model, __, options) => {
      options?.onPayload?.(payload, model);
      return {} as never;
    }) as StreamFn;

    const wrapped = logger?.wrapStreamFn(streamFn);
    await wrapped?.({ api: "anthropic-messages" } as never, { messages: [] } as never, {});

    const event = JSON.parse(lines[0]?.trim() ?? "{}") as Record<string, unknown>;
    const sanitizedPayload = (event.payload ?? {}) as Record<string, unknown>;
    const message = ((sanitizedPayload.messages as unknown[] | undefined) ?? []) as Array<
      Record<string, unknown>
    >;
    const source = (((message[0]?.content as Array<Record<string, unknown>> | undefined) ?? [])[0]
      ?.source ?? {}) as Record<string, unknown>;
    const metadata = (sanitizedPayload.metadata ?? {}) as Record<string, unknown>;
    expect(message[0]).not.toHaveProperty("authorization");
    expect(metadata).not.toHaveProperty("api_key");
    expect(metadata).not.toHaveProperty("nestedToken");
    expect(metadata.tokenBudget).toBe(1024);
    expect(source.data).toBe("<redacted>");
    expect(source.bytes).toBe(4);
    expect(source.sha256).toBe(crypto.createHash("sha256").update("QUJDRA==").digest("hex"));
    expect(event.payloadDigest).toBeDefined();
  });
});
