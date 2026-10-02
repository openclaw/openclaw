// Verifies the read-only OpenClaw gateway tool schema and config reads.
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { REDACTED_SENTINEL, redactConfigSnapshot } from "../config/redact-snapshot.js";
import { makeSnapshot } from "../config/redact-snapshot.test-helpers.js";
import { GatewayClientRequestError } from "../gateway/client.js";
import { applyCodeModeCatalog } from "./code-mode.js";
import {
  createCodeModeHarness,
  resetCodeModeTestState,
  resultDetails,
} from "./code-mode.test-support.js";
import { createGatewayTool } from "./tools/gateway-tool.js";
import { callGatewayTool } from "./tools/gateway.js";

const { callGatewayToolMock, readGatewayCallOptionsMock } = vi.hoisted(() => ({
  callGatewayToolMock: vi.fn(),
  readGatewayCallOptionsMock: vi.fn(() => ({})),
}));

vi.mock("./tools/gateway.js", () => ({
  callGatewayTool: callGatewayToolMock,
  readGatewayCallOptions: readGatewayCallOptionsMock,
}));

type GatewayCall = [method: string, options: unknown, params?: unknown];

function gatewayCall(method: string): GatewayCall {
  const call = (vi.mocked(callGatewayTool).mock.calls as GatewayCall[]).find(
    ([candidate]) => candidate === method,
  );
  if (!call) {
    throw new Error(`Expected gateway call for ${method}`);
  }
  return call;
}

function expectRecordFields(
  record: unknown,
  expected: Record<string, unknown>,
): Record<string, unknown> {
  if (!record || typeof record !== "object") {
    throw new Error("Expected record");
  }
  const actual = record as Record<string, unknown>;
  for (const [key, value] of Object.entries(expected)) {
    expect(actual[key]).toEqual(value);
  }
  return actual;
}

describe("gateway tool", () => {
  afterEach(resetCodeModeTestState);

  beforeEach(() => {
    callGatewayToolMock.mockClear();
    readGatewayCallOptionsMock.mockClear();
    callGatewayToolMock.mockImplementation(async (method: string) => {
      if (method === "config.get") {
        return {
          hash: "hash-1",
          config: {
            tools: {
              exec: {
                ask: "on-miss",
                security: "allowlist",
              },
            },
          },
        };
      }
      if (method === "config.schema.lookup") {
        return {
          path: "gateway.auth",
          schema: { type: "object" },
          hint: { label: "Gateway Auth" },
          hintPath: "gateway.auth",
          children: [
            {
              key: "token",
              path: "gateway.auth.token",
              type: "string",
              required: true,
              hasChildren: false,
              hint: { label: "Token", sensitive: true },
              hintPath: "gateway.auth.token",
            },
          ],
        };
      }
      return { ok: true };
    });
  });

  it("preserves scoped redacted config.get data through Code Mode", async () => {
    const secret = "fixture-gateway-token-not-live";
    const snapshot = redactConfigSnapshot(
      makeSnapshot({ gateway: { port: 19_001, auth: { token: secret } } }),
      { "gateway.auth.token": { sensitive: true } },
    );
    callGatewayToolMock.mockResolvedValue(snapshot);
    const gateway = createGatewayTool();
    const direct = await gateway.execute("direct-config", {
      action: "config.get",
      path: "gateway",
    });
    const text = expectDefined(
      direct.content.find((part) => part.type === "text"),
      "config JSON content",
    );
    const expected = {
      ok: true,
      result: {
        hash: "abc123",
        path: "gateway",
        config: { port: 19_001, auth: { token: REDACTED_SENTINEL } },
      },
    };
    expect(JSON.parse(text.text)).toEqual(expected);
    const h = createCodeModeHarness();
    applyCodeModeCatalog({ ...h.ctx, tools: [...h.tools, gateway] });
    const bridged = resultDetails(
      await h.tools[0]!.execute("config-through-code", {
        code: 'return await gateway({ action: "config.get", path: "gateway" });',
      }),
    );
    expect(bridged).toMatchObject({ status: "completed", value: expected });
    expect(JSON.stringify(bridged)).not.toContain(secret);
  });

  it("scopes both config.get result representations to the requested path", async () => {
    const result = await createGatewayTool().execute("call-config-get", {
      action: "config.get",
      path: "tools.exec",
    });

    expect(result.details).toEqual({
      ok: true,
      result: {
        hash: "hash-1",
        path: "tools.exec",
        config: { ask: "on-miss", security: "allowlist" },
      },
    });
    expect(result.content).toEqual([
      {
        type: "text",
        text: JSON.stringify(
          {
            ok: true,
            result: {
              hash: "hash-1",
              path: "tools.exec",
              config: {
                ask: "on-miss",
                security: "allowlist",
              },
            },
          },
          null,
          2,
        ),
      },
    ]);
  });

  it.each([
    ["tools.missing", "config path not found: tools.missing"],
    ["...", "config path not found: ..."],
    ["constructor.prototype", "config path not found: constructor.prototype"],
  ])("rejects invalid config.get path %s", async (path, message) => {
    await expect(
      createGatewayTool().execute("call-invalid-config-path", {
        action: "config.get",
        path,
      }),
    ).rejects.toThrow(message);
  });

  it("reads config.get paths with bracketed array indexes", async () => {
    callGatewayToolMock.mockResolvedValueOnce({
      config: {
        agents: {
          list: [{ id: "ops" }],
        },
      },
    });

    const result = await createGatewayTool().execute("call-indexed-config-path", {
      action: "config.get",
      path: "agents.list[0].id",
    });

    expect(result.content).toEqual([
      {
        type: "text",
        text: JSON.stringify(
          {
            ok: true,
            result: {
              path: "agents.list[0].id",
              config: "ops",
            },
          },
          null,
          2,
        ),
      },
    ]);
  });

  it("requires a narrower config.get path for oversized output", async () => {
    callGatewayToolMock.mockResolvedValueOnce({
      config: { oversized: "x".repeat(100_000) },
    });

    await expect(
      createGatewayTool().execute("call-large-config", {
        action: "config.get",
      }),
    ).rejects.toThrow(
      "config.get response is too large; use path to request a narrower config subtree",
    );
  });

  it("returns a path-scoped schema lookup result", async () => {
    const result = await createGatewayTool().execute("call-schema", {
      action: "config.schema.lookup",
      path: "gateway.auth",
    });

    expect(gatewayCall("config.schema.lookup")[2]).toEqual({ path: "gateway.auth" });
    const details = expectRecordFields(result.details, { ok: true });
    const lookupResult = expectRecordFields(details.result, {
      path: "gateway.auth",
      hintPath: "gateway.auth",
    });
    const children = lookupResult.children as Array<unknown>;
    expect(children).toHaveLength(1);
    expectRecordFields(children[0], {
      key: "token",
      path: "gateway.auth.token",
      required: true,
      hintPath: "gateway.auth.token",
    });
  });

  it("returns an in-band schema lookup miss for unknown paths", async () => {
    callGatewayToolMock.mockRejectedValueOnce(
      new GatewayClientRequestError({
        code: "INVALID_REQUEST",
        message: "config schema path not found",
      }),
    );

    const result = await createGatewayTool().execute("call-missing-schema", {
      action: "config.schema.lookup",
      path: "agents.main.authorizedSenders",
    });

    expect(gatewayCall("config.schema.lookup")[2]).toEqual({
      path: "agents.main.authorizedSenders",
    });
    expect(result.details).toEqual({
      ok: false,
      code: "schema_path_not_found",
      path: "agents.main.authorizedSenders",
      message: "config schema path not found",
    });
  });
});
