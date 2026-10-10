/** Tests ACP metadata session-key resolution against Gateway defaults and lookups. */
import { describe, expect, it, vi } from "vitest";
import type { GatewayClient } from "../gateway/client.js";
import { parseSessionMeta, resolveAcpSessionKey } from "./session-mapper.js";

function createGateway(resolveLabelKey = "agent:main:label"): {
  gateway: GatewayClient;
  request: ReturnType<typeof vi.fn>;
} {
  const request = vi.fn(async (method: string, params: Record<string, unknown>) => {
    if (method === "sessions.resolve" && "label" in params) {
      return { ok: true, key: resolveLabelKey };
    }
    if (method === "sessions.resolve" && "key" in params) {
      return { ok: true, key: params.key as string };
    }
    return { ok: true };
  });

  return {
    gateway: { request } as unknown as GatewayClient,
    request,
  };
}

describe("acp session mapper", () => {
  it("prefers explicit sessionLabel over sessionKey", async () => {
    const { gateway, request } = createGateway();
    const meta = parseSessionMeta({ sessionLabel: "support", sessionKey: "agent:main:main" });

    const key = await resolveAcpSessionKey({
      meta,
      fallbackKey: "acp:fallback",
      gateway,
      opts: {},
    });

    expect(key).toBe("agent:main:label");
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith("sessions.resolve", { label: "support" });
  });

  it("lets meta sessionKey override default label", async () => {
    const { gateway, request } = createGateway();
    const meta = parseSessionMeta({ sessionKey: "agent:main:override" });

    const key = await resolveAcpSessionKey({
      meta,
      fallbackKey: "acp:fallback",
      gateway,
      opts: { defaultSessionLabel: "default-label" },
    });

    expect(key).toBe("agent:main:override");
    expect(request).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "resolves the default label ahead of the default key",
      meta: {},
      opts: { defaultSessionLabel: "default-label", defaultSessionKey: "default-key" },
      expected: "agent:main:label",
      lookup: { label: "default-label" },
    },
    {
      name: "uses the default key without a lookup",
      meta: {},
      opts: { defaultSessionKey: "default-key" },
      expected: "default-key",
      lookup: undefined,
    },
    {
      name: "resolves an existing default key",
      meta: {},
      opts: { defaultSessionKey: "default-key", requireExistingSession: true },
      expected: "default-key",
      lookup: { key: "default-key" },
    },
    {
      name: "resolves an explicit existing key ahead of the default label",
      meta: { sessionKey: "explicit-key", requireExisting: true },
      opts: { defaultSessionLabel: "default-label" },
      expected: "explicit-key",
      lookup: { key: "explicit-key" },
    },
    {
      name: "allows metadata to disable the default existing-key requirement",
      meta: { requireExisting: false },
      opts: { defaultSessionKey: "default-key", requireExistingSession: true },
      expected: "default-key",
      lookup: undefined,
    },
    {
      name: "uses the fallback without a lookup when routing is unset",
      meta: {},
      opts: { requireExistingSession: true },
      expected: "acp:fallback",
      lookup: undefined,
    },
  ])("$name", async ({ meta, opts, expected, lookup }) => {
    const { gateway, request } = createGateway();
    expect(await resolveAcpSessionKey({ meta, opts, gateway, fallbackKey: "acp:fallback" })).toBe(
      expected,
    );
    expect(request.mock.calls).toEqual(lookup ? [["sessions.resolve", lookup]] : []);
  });
});
