import { RequestedModelUnsupportedError, type AcpxRuntime as UpstreamRuntime } from "acpx/runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AcpRuntimeError } from "../runtime-api.js";
import {
  CODEX_ACP_COMMAND,
  codexEffortCapabilities,
  makeControlRuntime,
  makeEmptySessionStore,
  makeRuntime,
} from "./runtime.test-support.js";

const unadvertised = () =>
  new RequestedModelUnsupportedError("model not advertised", "unadvertised-model");

describe("AcpxRuntime model controls", () => {
  beforeEach(() => vi.restoreAllMocks());

  it.each<{
    name: string;
    configOptionKeys: string[] | undefined;
    models: { currentModelId: string; availableModelIds?: string[] };
    statusConfigOptions?: unknown[];
    expected: string[];
    expectedKeys?: string[];
  }>([
    {
      name: "config and models with unreported status options",
      configOptionKeys: ["model", "effort"],
      models: { currentModelId: "m1", availableModelIds: ["m1"] },
      expected: ["session/set_mode", "session/set_model", "session/set_config_option"],
    },
    {
      name: "status options recorded after an unadvertised capability read",
      configOptionKeys: undefined,
      models: { currentModelId: "m1" },
      statusConfigOptions: [{ id: "model" }, { id: "effort" }, { id: " " }, { category: "x" }],
      expected: ["session/set_mode", "session/set_config_option"],
      expectedKeys: ["model", "effort"],
    },
    {
      name: "status options replacing stale capability keys",
      configOptionKeys: ["model"],
      models: { currentModelId: "m1" },
      statusConfigOptions: [{ id: "effort" }],
      expected: ["session/set_mode", "session/set_config_option"],
      expectedKeys: ["effort"],
    },
    {
      name: "explicitly empty status options over stale capability keys",
      configOptionKeys: ["model", "effort"],
      models: { currentModelId: "m1", availableModelIds: ["m1"] },
      statusConfigOptions: [],
      expected: ["session/set_mode", "session/set_model"],
      expectedKeys: undefined,
    },
    {
      name: "models only without config options",
      configOptionKeys: undefined,
      models: { currentModelId: "m1", availableModelIds: ["m1"] },
      expected: ["session/set_mode", "session/set_model"],
    },
    {
      name: "partial models report",
      configOptionKeys: undefined,
      models: { currentModelId: "m1" },
      expected: ["session/set_mode"],
    },
    {
      name: "empty session config options with models",
      configOptionKeys: [],
      models: { currentModelId: "m1", availableModelIds: ["m1"] },
      expected: ["session/set_mode", "session/set_model"],
    },
  ])("projects only session-advertised controls: $name", async (testCase) => {
    const { runtime, delegate } = makeRuntime(makeEmptySessionStore());
    const getCapabilities = vi.spyOn(delegate, "getCapabilities").mockResolvedValue({
      controls: [
        "session/set_mode",
        "session/set_model",
        "session/set_config_option",
        "session/status",
      ],
      ...(testCase.configOptionKeys ? { configOptionKeys: testCase.configOptionKeys } : {}),
    });
    // Partial reports are untrusted wire data; the cast models a malformed status.
    const status = {
      models: testCase.models,
      ...(testCase.statusConfigOptions
        ? { details: { configOptions: testCase.statusConfigOptions } }
        : {}),
    } as Awaited<ReturnType<UpstreamRuntime["getStatus"]>>;
    const getStatus = vi.spyOn(delegate, "getStatus").mockResolvedValue(status);
    const handle = {
      sessionKey: "agent:main:acp:test",
      backend: "acpx",
      runtimeSessionName: "agent:main:acp:test",
    };
    const expectedKeys =
      "expectedKeys" in testCase ? testCase.expectedKeys : testCase.configOptionKeys;
    expect(await runtime.getCapabilities({ handle })).toEqual({
      controls: [...testCase.expected, "session/status"],
      ...(expectedKeys ? { configOptionKeys: expectedKeys } : {}),
    });
    expect(getCapabilities).toHaveBeenCalledOnce();
    expect(getStatus).toHaveBeenCalledOnce();
  });

  it("does not offer set_model without a session announcement", async () => {
    const { runtime, delegate } = makeRuntime(makeEmptySessionStore());
    vi.spyOn(delegate, "getCapabilities").mockResolvedValue(codexEffortCapabilities);
    const getStatus = vi.spyOn(delegate, "getStatus");
    const capabilities = await runtime.getCapabilities({});
    expect(capabilities.controls).not.toContain("session/set_model");
    expect(getStatus).not.toHaveBeenCalled();
  });

  it("selects generic models exact-first and reports the void set_model result", async () => {
    const { runtime, delegate, handle } = makeControlRuntime("gemini", "gemini --acp");
    const setModel = vi
      .spyOn(delegate, "setModel")
      .mockRejectedValueOnce(unadvertised())
      .mockResolvedValueOnce(undefined);
    const getStatus = vi.spyOn(delegate, "getStatus");

    await expect(
      runtime.setModel({ handle, model: "example/example-model" }),
    ).resolves.toBeUndefined();
    expect(setModel.mock.calls.map(([input]) => input.model)).toEqual([
      "example/example-model",
      "example-model",
    ]);
    expect(getStatus).not.toHaveBeenCalled();
  });

  it.each([
    { agent: "codex", command: CODEX_ACP_COMMAND, model: "openai/gpt-5.4/high" },
    { agent: "claude", command: "claude-agent-acp", model: "anthropic/claude-sonnet-4-6" },
  ])("sends an advertised exact $agent id through set_model unchanged", async (testCase) => {
    const { runtime, delegate, handle } = makeControlRuntime(testCase.agent, testCase.command);
    const setModel = vi.spyOn(delegate, "setModel").mockResolvedValue(undefined);
    const setConfigOption = vi.spyOn(delegate, "setConfigOption").mockResolvedValue(undefined);
    await expect(runtime.setModel({ handle, model: testCase.model })).resolves.toBeUndefined();
    expect(setModel.mock.calls.map(([input]) => input.model)).toEqual([testCase.model]);
    expect(setConfigOption).not.toHaveBeenCalled();
  });

  it("normalizes Codex and Claude set_model ids only after a typed pre-wire rejection", async () => {
    const codex = makeControlRuntime("codex", CODEX_ACP_COMMAND);
    vi.spyOn(codex.delegate, "getCapabilities").mockResolvedValue(codexEffortCapabilities);
    vi.spyOn(codex.delegate, "getStatus").mockResolvedValue({});
    const codexSetModel = vi
      .spyOn(codex.delegate, "setModel")
      .mockRejectedValueOnce(unadvertised())
      .mockResolvedValueOnce(undefined);
    const codexConfig = vi.spyOn(codex.delegate, "setConfigOption").mockResolvedValue(undefined);
    await codex.runtime.setModel({ handle: codex.handle, model: "openai/gpt-5.4/high" });
    expect(codexSetModel.mock.calls.map(([input]) => input.model)).toEqual([
      "openai/gpt-5.4/high",
      "gpt-5.4",
    ]);
    expect(codexConfig.mock.calls.map(([input]) => [input.key, input.value])).toEqual([
      ["reasoning_effort", "high"],
    ]);
    // An unknown replacement never inherits a provider; Codex refuses it after the exact try.
    codexSetModel.mockRejectedValueOnce(unadvertised());
    await expect(
      codex.runtime.setModel({ handle: codex.handle, model: "example/example-model" }),
    ).rejects.toMatchObject({ code: "ACP_INVALID_RUNTIME_OPTION" });
    expect(codexSetModel).toHaveBeenCalledTimes(3);

    const claude = makeControlRuntime("claude", "claude-agent-acp");
    const claudeSetModel = vi.spyOn(claude.delegate, "setModel").mockRejectedValue(unadvertised());
    await expect(
      claude.runtime.setModel({ handle: claude.handle, model: "anthropic/claude-sonnet-4-6" }),
    ).rejects.toThrow("model not advertised");
    await expect(
      claude.runtime.setModel({ handle: claude.handle, model: "claude-sonnet-4-6" }),
    ).rejects.toThrow("model not advertised");
    expect(claudeSetModel.mock.calls.map(([input]) => input.model)).toEqual([
      "anthropic/claude-sonnet-4-6",
      "claude-sonnet-4-6",
      "claude-sonnet-4-6",
    ]);
  });

  it("does not retry a rejected model write or read status as acceptance evidence", async () => {
    const { runtime, delegate, handle } = makeControlRuntime("claude", "claude-agent-acp");
    const setModel = vi
      .spyOn(delegate, "setModel")
      .mockRejectedValueOnce(new AcpRuntimeError("ACP_TURN_FAILED", "-32601 Method not found"));
    const getStatus = vi.spyOn(delegate, "getStatus");
    await expect(
      runtime.setModel({ handle, model: "anthropic/claude-sonnet-4-6" }),
    ).rejects.toThrow("-32601");
    expect(setModel).toHaveBeenCalledOnce();
    expect(getStatus).not.toHaveBeenCalled();

    setModel.mockResolvedValueOnce(undefined);
    await expect(runtime.setModel({ handle, model: "claude-sonnet-4-6" })).resolves.toBeUndefined();
    expect(getStatus).not.toHaveBeenCalled();
  });

  it.each([
    { name: "no config snapshot", configOptions: undefined },
    {
      name: "a stale snapshot without a model option",
      configOptions: [{ id: "effort", category: "thought_level", currentValue: "low" }],
    },
    {
      name: "a stale snapshot with the previous model",
      configOptions: [
        { id: "model_selector", category: "model", currentValue: "example-model-before" },
      ],
    },
  ])("does not certify the ACPX set_model echo with $name", async ({ configOptions }) => {
    const { runtime, delegate, handle } = makeControlRuntime("gemini", "gemini --acp");
    const requested = "example-model-requested";
    // ACPX set_model returns void and caches the requested id as its current model.
    let currentModelId = "example-model-before";
    const setModel = vi.spyOn(delegate, "setModel").mockImplementation(async ({ model }) => {
      currentModelId = model;
    });
    const getStatus = vi.spyOn(delegate, "getStatus").mockImplementation(async () => ({
      models: { currentModelId, availableModelIds: ["example-model-before", requested] },
      ...(configOptions ? { details: { configOptions } } : {}),
    }));

    await expect(runtime.setModel({ handle, model: requested })).resolves.toBeUndefined();
    expect(setModel.mock.calls.map(([input]) => input.model)).toEqual([requested]);
    expect(getStatus).not.toHaveBeenCalled();
  });

  it("refuses Codex effort on a models-only session before any write", async () => {
    const { runtime, delegate, handle } = makeControlRuntime("codex", CODEX_ACP_COMMAND);
    const availableModelIds = ["example-model-before", "gpt-5.4"];
    let currentModelId = "example-model-before";
    vi.spyOn(delegate, "getCapabilities").mockResolvedValue({
      controls: ["session/set_mode", "session/set_model", "session/status"],
    });
    const setModel = vi.spyOn(delegate, "setModel").mockImplementation(async ({ model }) => {
      if (!availableModelIds.includes(model)) {
        throw unadvertised();
      }
      currentModelId = model;
    });
    const setConfigOption = vi.spyOn(delegate, "setConfigOption");
    vi.spyOn(delegate, "getStatus").mockImplementation(async () => ({
      models: { currentModelId, availableModelIds },
    }));

    await expect(runtime.setModel({ handle, model: "openai/gpt-5.4/high" })).rejects.toMatchObject({
      code: "ACP_BACKEND_UNSUPPORTED_CONTROL",
    });
    // Only ACPX's typed pre-wire rejection ran; no model or effort reached the wire.
    expect(setModel.mock.calls.map(([input]) => input.model)).toEqual(["openai/gpt-5.4/high"]);
    expect(currentModelId).toBe("example-model-before");
    expect(setConfigOption).not.toHaveBeenCalled();

    // A plain model on the same models-only session stays usable and unverified.
    await expect(runtime.setModel({ handle, model: "openai/gpt-5.4" })).resolves.toBeUndefined();
    expect(setModel.mock.calls.map(([input]) => input.model)).toEqual([
      "openai/gpt-5.4/high",
      "openai/gpt-5.4",
      "gpt-5.4",
    ]);
    expect(setConfigOption).not.toHaveBeenCalled();
  });

  const modelKeyCapabilities: Awaited<ReturnType<UpstreamRuntime["getCapabilities"]>> = {
    controls: ["session/set_config_option", "session/status"],
    configOptionKeys: ["model"],
  };
  it.each<{
    name: string;
    capabilities: Awaited<ReturnType<UpstreamRuntime["getCapabilities"]>>;
    status: Awaited<ReturnType<UpstreamRuntime["getStatus"]>>;
    refused: boolean;
  }>([
    {
      name: "a model-only capability key",
      capabilities: modelKeyCapabilities,
      status: {},
      refused: true,
    },
    {
      // A genuine empty status list supersedes stale capability keys listing reasoning_effort.
      name: "a genuine empty status option list",
      capabilities: codexEffortCapabilities,
      status: { details: { configOptions: [] } },
      refused: true,
    },
    {
      name: "effort announced only in the session status",
      capabilities: modelKeyCapabilities,
      status: {
        details: {
          configOptions: [
            { id: "model", category: "model", currentValue: "gpt-5.4" },
            { id: "reasoning_effort", category: "thought_level", currentValue: "low" },
          ],
        },
      },
      refused: false,
    },
  ])("gates Codex config-model effort on $name", async ({ capabilities, status, refused }) => {
    const { runtime, delegate, handle } = makeControlRuntime("codex", CODEX_ACP_COMMAND);
    vi.spyOn(delegate, "getCapabilities").mockResolvedValue(capabilities);
    vi.spyOn(delegate, "getStatus").mockResolvedValue(status);
    const setModel = vi.spyOn(delegate, "setModel");
    const setConfigOption = vi.spyOn(delegate, "setConfigOption").mockResolvedValue(undefined);
    const result = runtime.setConfigOption({ handle, key: "model", value: "openai/gpt-5.4/high" });
    if (refused) {
      await expect(result).rejects.toMatchObject({ code: "ACP_BACKEND_UNSUPPORTED_CONTROL" });
      expect(setConfigOption).not.toHaveBeenCalled();
    } else {
      await expect(result).resolves.toBeUndefined();
      expect(setConfigOption.mock.calls.map(([input]) => [input.key, input.value])).toEqual([
        ["model", "gpt-5.4"],
        ["reasoning_effort", "high"],
      ]);
    }
    expect(setModel).not.toHaveBeenCalled();
  });

  it.each([
    { name: "the normalized wire model", reported: "gpt-5.4", model: "openai/gpt-5.4" },
    { name: "a different server model", reported: "gpt-5.5", model: "gpt-5.5" },
  ])("qualifies only $name in a genuine Codex config response", async ({ reported, model }) => {
    const effort = {
      id: "reasoning_effort",
      category: "thought_level",
      currentValue: "high",
      options: [{ value: "medium" }, { value: "high" }],
    };
    const accepted = {
      configOptions: [{ id: "model", category: "model", currentValue: reported }, effort],
    };
    const expected = {
      configOptions: [{ id: "model", category: "model", currentValue: model }, effort],
    };

    const viaConfig = makeControlRuntime("codex", CODEX_ACP_COMMAND);
    vi.spyOn(viaConfig.delegate, "getCapabilities").mockResolvedValue(codexEffortCapabilities);
    vi.spyOn(viaConfig.delegate, "getStatus").mockResolvedValue({});
    const setConfigOption = vi
      .spyOn(viaConfig.delegate, "setConfigOption")
      .mockResolvedValue(accepted);
    await expect(
      viaConfig.runtime.setConfigOption({
        handle: viaConfig.handle,
        key: "model",
        value: "openai/gpt-5.4/high",
      }),
    ).resolves.toEqual(expected);
    expect(setConfigOption.mock.calls.map(([input]) => [input.key, input.value])).toEqual([
      ["model", "gpt-5.4"],
      ["reasoning_effort", "high"],
    ]);

    const viaSetModel = makeControlRuntime("codex", CODEX_ACP_COMMAND);
    vi.spyOn(viaSetModel.delegate, "getCapabilities").mockResolvedValue(codexEffortCapabilities);
    vi.spyOn(viaSetModel.delegate, "getStatus").mockResolvedValue({});
    const setModel = vi
      .spyOn(viaSetModel.delegate, "setModel")
      .mockRejectedValueOnce(unadvertised())
      .mockResolvedValueOnce(undefined);
    vi.spyOn(viaSetModel.delegate, "setConfigOption").mockResolvedValue(accepted);
    await expect(
      viaSetModel.runtime.setModel({ handle: viaSetModel.handle, model: "openai/gpt-5.4/high" }),
    ).resolves.toEqual(expected);
    expect(setModel.mock.calls.map(([input]) => input.model)).toEqual([
      "openai/gpt-5.4/high",
      "gpt-5.4",
    ]);
  });

  it.each([
    { name: "bare model", key: "model", value: "gpt-5.4", calls: [["model", "gpt-5.4"]] },
    {
      name: "empty qualified model",
      key: "model",
      value: "openai//high",
      error: "ACP_INVALID_RUNTIME_OPTION",
    },
    {
      name: "reasoning suffix",
      key: "model",
      value: "openai/gpt-5.4/high",
      calls: [
        ["model", "gpt-5.4"],
        ["reasoning_effort", "high"],
      ],
    },
    {
      name: "unsupported model",
      key: "model",
      value: "google/gemini-3.1-flash-lite",
      error: "ACP_INVALID_RUNTIME_OPTION",
    },
    {
      name: "reasoning alias",
      key: "reasoning_effort",
      value: "x-high",
      calls: [["reasoning_effort", "xhigh"]],
    },
    {
      name: "clearing thinking",
      key: "thought_level",
      value: "off",
      error: "ACP_BACKEND_UNSUPPORTED_CONTROL",
    },
    { name: "Claude timeout", agent: "claude", key: "Timeout_Seconds", value: "60", calls: [] },
    {
      name: "Claude model",
      agent: "claude",
      key: "model",
      value: "arn:aws:bedrock:us-east-1:123456789012:inference-profile/claude",
      calls: [["model", "arn:aws:bedrock:us-east-1:123456789012:inference-profile/claude"]],
    },
  ])("normalizes config control: $name", async ({ agent = "codex", key, value, calls, error }) => {
    const command = agent === "codex" ? CODEX_ACP_COMMAND : "claude-agent-acp.exe";
    const { runtime, delegate, handle } = makeControlRuntime(agent, command);
    const accepted = { configOptions: [{ id: "effort", currentValue: "high" }] };
    vi.spyOn(delegate, "getCapabilities").mockResolvedValue(codexEffortCapabilities);
    vi.spyOn(delegate, "getStatus").mockResolvedValue({});
    const update = vi.spyOn(delegate, "setConfigOption").mockResolvedValue(accepted);
    const result = runtime.setConfigOption({ handle, key, value });
    if (error) {
      await expect(result).rejects.toMatchObject({ code: error });
      expect(update).not.toHaveBeenCalled();
    } else {
      await expect(result).resolves.toEqual(calls?.length ? accepted : undefined);
      expect(update.mock.calls).toEqual(
        calls?.map(([controlKey, controlValue]) => [
          { handle, key: controlKey, value: controlValue },
        ]),
      );
    }
  });
});
