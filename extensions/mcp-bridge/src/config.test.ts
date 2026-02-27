import { describe, expect, it } from "vitest";
import { parseConfig, configSchema } from "./config.js";

describe("parseConfig", () => {
  it("parses a valid http server config", () => {
    const result = parseConfig({
      servers: [
        {
          name: "lark_project",
          type: "http",
          url: "https://project.feishu.cn/mcp_server/v1?mcpKey=abc",
        },
      ],
    });
    expect(result.servers).toHaveLength(1);
    expect(result.servers[0].name).toBe("lark_project");
    expect(result.servers[0].type).toBe("http");
  });

  it("parses a valid stdio server config", () => {
    const result = parseConfig({
      servers: [
        {
          name: "local_tool",
          type: "stdio",
          command: "node",
          args: ["server.js"],
        },
      ],
    });
    expect(result.servers).toHaveLength(1);
    expect(result.servers[0].type).toBe("stdio");
  });

  it("parses a valid sse server config", () => {
    const result = parseConfig({
      servers: [
        {
          name: "legacy_server",
          type: "sse",
          url: "https://example.com/sse",
        },
      ],
    });
    expect(result.servers).toHaveLength(1);
    expect(result.servers[0].type).toBe("sse");
  });

  it("parses multiple servers", () => {
    const result = parseConfig({
      servers: [
        { name: "a", type: "http", url: "https://a.com/mcp" },
        { name: "b", type: "stdio", command: "node", args: ["b.js"] },
      ],
    });
    expect(result.servers).toHaveLength(2);
  });

  it("rejects empty servers array", () => {
    expect(() => parseConfig({ servers: [] })).toThrow();
  });

  it("rejects missing name", () => {
    expect(() =>
      parseConfig({
        servers: [{ type: "http", url: "https://example.com" }],
      }),
    ).toThrow();
  });

  it("rejects invalid url", () => {
    expect(() =>
      parseConfig({
        servers: [{ name: "x", type: "http", url: "not-a-url" }],
      }),
    ).toThrow();
  });

  it("rejects unknown transport type", () => {
    expect(() =>
      parseConfig({
        servers: [{ name: "x", type: "websocket", url: "wss://example.com" }],
      }),
    ).toThrow();
  });
});

describe("configSchema.safeParse", () => {
  it("returns success for valid config", () => {
    const result = configSchema.safeParse({
      servers: [{ name: "test", type: "http", url: "https://example.com/mcp" }],
    });
    expect(result.success).toBe(true);
  });

  it("returns error for invalid config", () => {
    const result = configSchema.safeParse({ servers: [] });
    expect(result.success).toBe(false);
    expect(result.error?.issues).toBeDefined();
  });
});
