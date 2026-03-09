import { describe, expect, it } from "vitest";
import {
  ACP_REMOTE_DRAFT_REVISION,
  ACP_REMOTE_PROTOCOL_VERSION,
  createAcpRemotePluginConfigSchema,
  resolveAcpRemotePluginConfig,
} from "./config.js";

describe("acp-remote plugin config parsing", () => {
  it("requires a valid absolute URL", () => {
    const resolved = resolveAcpRemotePluginConfig({
      rawConfig: {
        url: "http://127.0.0.1:8787/acp",
      },
    });

    expect(resolved.url).toBe("http://127.0.0.1:8787/acp");
    expect(resolved.timeoutMs).toBe(30_000);
    expect(resolved.retryDelayMs).toBe(150);
    expect(resolved.requiredDraftRevision).toBe(ACP_REMOTE_DRAFT_REVISION);
    expect(resolved.protocolVersion).toBe(ACP_REMOTE_PROTOCOL_VERSION);
  });

  it("preserves optional headers and timing overrides", () => {
    const resolved = resolveAcpRemotePluginConfig({
      rawConfig: {
        url: "http://127.0.0.1:8787/acp",
        headers: {
          Authorization: "Bearer test",
        },
        timeoutSeconds: 12.5,
        retryDelayMs: 5,
        requiredDraftRevision: "draft-x",
        protocolVersion: 7,
      },
    });

    expect(resolved.headers).toEqual({
      Authorization: "Bearer test",
    });
    expect(resolved.timeoutMs).toBe(12_500);
    expect(resolved.retryDelayMs).toBe(5);
    expect(resolved.requiredDraftRevision).toBe("draft-x");
    expect(resolved.protocolVersion).toBe(7);
  });

  it("rejects invalid headers", () => {
    expect(() =>
      resolveAcpRemotePluginConfig({
        rawConfig: {
          url: "http://127.0.0.1:8787/acp",
          headers: {
            Authorization: 1,
          },
        },
      }),
    ).toThrow("headers must be an object of string values");
  });

  it("schema rejects malformed URLs", () => {
    const schema = createAcpRemotePluginConfigSchema();
    if (!schema.safeParse) {
      throw new Error("acp-remote config schema missing safeParse");
    }
    const parsed = schema.safeParse({
      url: "relative/path",
    });

    expect(parsed.success).toBe(false);
  });

  it("rejects unknown config keys", () => {
    expect(() =>
      resolveAcpRemotePluginConfig({
        rawConfig: {
          url: "http://127.0.0.1:8787/acp",
          transport: "sse",
        },
      }),
    ).toThrow("unknown config key: transport");
  });
});
