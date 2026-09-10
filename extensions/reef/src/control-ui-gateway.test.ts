import type { OpenClawPluginApi } from "openclaw/plugin-sdk/channel-entry-contract";
import { ErrorCodes } from "openclaw/plugin-sdk/gateway-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerReefControlUiGatewayMethods } from "./control-ui-gateway.js";

const mocks = vi.hoisted(() => ({
  command: vi.fn(),
  active: {
    friends: {
      list: vi.fn(),
    },
    federation: {
      listMounts: vi.fn(),
      listPromptProposals: vi.fn(),
      listOutboundPromptProposals: vi.fn(),
    },
  },
  getActiveReef: vi.fn(),
}));

vi.mock("./commands.js", () => ({
  handleReefCommandWords: mocks.command,
}));

vi.mock("./runtime.js", () => ({
  getActiveReef: mocks.getActiveReef,
}));

type GatewayHandler = Parameters<OpenClawPluginApi["registerGatewayMethod"]>[1];
type GatewayOptions = Parameters<OpenClawPluginApi["registerGatewayMethod"]>[2];

function registerMethods(config: unknown = {}) {
  const methods = new Map<string, { handler: GatewayHandler; opts: GatewayOptions }>();
  const api = {
    runtime: {
      config: {
        current: () => config,
      },
    },
    registerGatewayMethod: vi.fn(
      (method: string, handler: GatewayHandler, opts: GatewayOptions) => {
        methods.set(method, { handler, opts });
      },
    ),
  } as unknown as OpenClawPluginApi;
  registerReefControlUiGatewayMethods(api);
  return methods;
}

async function call(methods: ReturnType<typeof registerMethods>, method: string, params = {}) {
  const respond = vi.fn();
  await methods.get(method)?.handler({ params, respond } as never);
  return respond.mock.calls[0] ?? [];
}

describe("Reef Control UI Gateway methods", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getActiveReef.mockReturnValue(mocks.active);
    mocks.active.friends.list.mockResolvedValue([
      {
        peer: "guest",
        status: "active",
        autonomy: "bounded",
        fingerprint: "reef-fingerprint",
      },
    ]);
    mocks.active.federation.listMounts.mockReturnValue([
      {
        mountId: "mount-host",
        peer: "guest",
        role: "host",
        sessionKey: "agent:main:shared",
        grantGeneration: 0,
        allowAlways: false,
        revoked: false,
      },
    ]);
    mocks.active.federation.listPromptProposals.mockReturnValue([
      {
        proposalId: "proposal-inbound",
        mountId: "mount-host",
        status: "pending",
        approvalId: "plugin:approval",
        request: { peer: "guest", frame: { text: "Check the build" } },
      },
    ]);
    mocks.active.federation.listOutboundPromptProposals.mockReturnValue([
      {
        peer: "host",
        frame: {
          proposalId: "proposal-outbound",
          mountId: "mount-guest",
          text: "Summarize the result",
        },
        outcome: {
          type: "session.prompt.denied",
          reason: "operator-denied",
        },
      },
    ]);
    mocks.command.mockResolvedValue({ text: "Reef command completed." });
  });

  it("registers one read method and owner-only mutations", () => {
    const methods = registerMethods();

    expect([...methods.keys()]).toEqual([
      "reef.controlUi.status",
      "reef.controlUi.friendCode",
      "reef.controlUi.friendRequest",
      "reef.controlUi.friendRemove",
      "reef.controlUi.sessionShare",
      "reef.controlUi.sessionRevoke",
      "reef.controlUi.sessionPrompt",
    ]);
    expect(methods.get("reef.controlUi.status")?.opts).toEqual({ scope: "operator.read" });
    for (const method of [...methods.keys()].slice(1)) {
      expect(methods.get(method)?.opts).toEqual({ scope: "operator.admin" });
    }
  });

  it("projects live friends, mounts, and text-only proposal status", async () => {
    const methods = registerMethods({
      channels: {
        reef: {
          handle: "host",
          email: "host@example.com",
          guard: {
            provider: "openai",
            pinnedModel: "gpt-5-mini",
            apiKeyEnv: "OPENAI_API_KEY",
            policyVersion: "2026-09-09",
            timeoutMs: 10_000,
          },
        },
      },
    });

    const [ok, payload] = await call(methods, "reef.controlUi.status");

    expect(ok).toBe(true);
    expect(payload).toMatchObject({
      configured: true,
      running: true,
      handle: "host",
      friends: [{ peer: "guest", status: "active", autonomy: "bounded" }],
      mounts: [{ mountId: "mount-host", role: "host", revoked: false }],
      proposals: [
        {
          direction: "inbound",
          peer: "guest",
          text: "Check the build",
          status: "pending",
          approvalId: "plugin:approval",
        },
        {
          direction: "outbound",
          peer: "host",
          text: "Summarize the result",
          status: "denied",
          reason: "operator-denied",
        },
      ],
    });
  });

  it("returns an explanatory unavailable state when the channel is inactive", async () => {
    mocks.getActiveReef.mockImplementation(() => {
      throw new Error("Reef channel is not running");
    });
    const methods = registerMethods({ channels: { reef: { handle: "host" } } });

    const [ok, payload] = await call(methods, "reef.controlUi.status");

    expect(ok).toBe(true);
    expect(payload).toMatchObject({
      configured: false,
      running: false,
      unavailableReason: "Reef channel is not running",
      friends: [],
      mounts: [],
      proposals: [],
    });
  });

  it("keeps mutations on the canonical owner command path", async () => {
    const methods = registerMethods();

    const [ok, payload] = await call(methods, "reef.controlUi.sessionPrompt", {
      mountId: "mount-guest",
      text: "Keep this text only",
    });

    expect(ok).toBe(true);
    expect(payload).toEqual({ message: "Reef command completed." });
    expect(mocks.command).toHaveBeenCalledWith({
      words: ["session", "prompt", "mount-guest", "Keep this text only"],
      senderIsOwner: true,
    });
  });

  it("does not reinterpret structured values as additional command arguments", async () => {
    const methods = registerMethods();

    await call(methods, "reef.controlUi.friendRequest", {
      peer: "guest",
      code: "code with spaces",
    });

    expect(mocks.command).toHaveBeenCalledWith({
      words: ["friend", "request", "guest", "code with spaces"],
      senderIsOwner: true,
    });
  });

  it("rejects malformed mutation parameters before command dispatch", async () => {
    const methods = registerMethods();

    const [ok, payload, error] = await call(methods, "reef.controlUi.sessionPrompt", {
      mountId: "mount-guest",
      text: "",
    });

    expect(ok).toBe(false);
    expect(payload).toBeUndefined();
    expect(error).toMatchObject({ code: ErrorCodes.INVALID_REQUEST });
    expect(mocks.command).not.toHaveBeenCalled();
  });

  it("rejects malformed identifiers before command dispatch", async () => {
    const methods = registerMethods();

    const [ok, payload, error] = await call(methods, "reef.controlUi.sessionShare", {
      peer: "guest other",
      sessionKey: "agent:main:shared",
    });

    expect(ok).toBe(false);
    expect(payload).toBeUndefined();
    expect(error).toMatchObject({ code: ErrorCodes.INVALID_REQUEST });
    expect(mocks.command).not.toHaveBeenCalled();
  });

  it("surfaces live status read failures instead of misreporting the channel as stopped", async () => {
    mocks.active.friends.list.mockRejectedValueOnce(new Error("state read failed"));
    const methods = registerMethods();

    const [ok, payload, error] = await call(methods, "reef.controlUi.status");

    expect(ok).toBe(false);
    expect(payload).toBeUndefined();
    expect(error).toMatchObject({ code: ErrorCodes.UNAVAILABLE, message: "state read failed" });
  });
});
