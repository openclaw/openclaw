/** A configured Claude binding keeps working when its inherited thinking level is not an advertised effort value. */
import { describe, expect, it } from "vitest";
import {
  baseCfg,
  createRuntime,
  hoisted,
  installAcpSessionManagerTestLifecycle,
  mockMutableSession,
  readySessionMeta,
} from "./control-plane/manager.test-helpers.js";
import { ensureConfiguredAcpBindingSession } from "./persistent-bindings.lifecycle.js";
import {
  buildConfiguredAcpSessionKey,
  type ConfiguredAcpBindingSpec,
} from "./persistent-bindings.types.js";

// Values claude-agent-acp advertises for its `effort` select option.
const ADVERTISED_EFFORT = ["default", "low", "medium", "high", "xhigh", "max"];

describe("configured ACP binding with an unadvertised inherited thinking level", () => {
  installAcpSessionManagerTestLifecycle();

  const spec: ConfiguredAcpBindingSpec = {
    channel: "discord",
    accountId: "default",
    conversationId: "1478836151241412759",
    agentId: "claude",
    mode: "persistent",
    thinking: "adaptive",
  };
  const sessionKey = buildConfiguredAcpSessionKey(spec);

  function setup() {
    const state = {
      currentMeta: readySessionMeta({
        agent: "claude",
        runtimeOptions: { thinking: "high" },
      }),
    };
    mockMutableSession(sessionKey, state);
    const { runtime, ...mocks } = createRuntime();
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({ id: "acpx", runtime });
    mocks.getCapabilities.mockResolvedValue({
      controls: ["session/set_mode", "session/set_config_option", "session/status"],
      configOptionKeys: ["mode", "model", "effort"],
    });
    mocks.getStatus.mockResolvedValue({
      details: {
        configOptions: [
          {
            id: "effort",
            currentValue: "high",
            options: ADVERTISED_EFFORT.map((value) => ({ value, name: value })),
          },
        ],
      },
    });
    // The adapter answers an unadvertised value with JSON-RPC -32603, as claude-agent-acp does.
    mocks.setConfigOption.mockImplementation(async ({ key, value }) => {
      if (key === "effort" && !ADVERTISED_EFFORT.includes(value)) {
        throw Object.assign(new Error("Internal error"), {
          name: "RequestError",
          code: -32603,
          data: { details: `Invalid value for config option effort: ${value}` },
        });
      }
    });
    return { state, ...mocks };
  }

  it("keeps the binding online and the accepted thinking level", async () => {
    const { state } = setup();
    await expect(ensureConfiguredAcpBindingSession({ cfg: baseCfg, spec })).resolves.toEqual({
      ok: true,
      sessionKey,
    });
    expect(state.currentMeta.runtimeOptions?.thinking).toBe("high");
  });

  it("still reports the rejection for an explicit thinking command", async () => {
    const { state } = setup();
    const { getAcpSessionManager } = await import("./control-plane/manager.js");
    await expect(
      getAcpSessionManager().setSessionConfigOption({
        cfg: baseCfg,
        sessionKey,
        agentId: "claude",
        key: "thinking",
        value: "adaptive",
      }),
    ).rejects.toMatchObject({ code: "ACP_TURN_FAILED" });
    expect(state.currentMeta.runtimeOptions?.thinking).toBe("high");
  });
});
