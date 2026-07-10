// Unadvertised optional tuning keys must not kill ACP spawns: the gateway
// injects a thinking default the caller cannot disable (#103802).
import { describe, expect, it, vi } from "vitest";
import { applyManagerRuntimeControls } from "./manager.runtime-controls.js";

function createParams(overrides: { configOptionKeys: string[] }) {
  const setConfigOption = vi.fn(async (_input: { key: string; value: string }) => {});
  const params = {
    sessionKey: "agent:main:acp:test",
    runtime: {
      getCapabilities: vi.fn(async () => ({
        controls: ["session/set_config_option"],
        configOptionKeys: overrides.configOptionKeys,
      })),
      setConfigOption,
    },
    handle: { backend: "acpx" },
    meta: { backend: "acpx", runtimeOptions: { thinking: "medium", model: "gpt-5.5" } },
    getCachedRuntimeState: () => null,
  };
  return {
    params: params as never as Parameters<typeof applyManagerRuntimeControls>[0],
    setConfigOption,
  };
}

describe("applyManagerRuntimeControls", () => {
  it("skips unadvertised thinking defaults instead of failing the spawn", async () => {
    const { params, setConfigOption } = createParams({ configOptionKeys: ["model"] });

    await applyManagerRuntimeControls(params);

    const appliedKeys = setConfigOption.mock.calls.map((call) => (call[0] as { key: string }).key);
    expect(appliedKeys).toContain("model");
    expect(appliedKeys).not.toContain("thinking");
  });

  it("still rejects unadvertised non-tuning config keys", async () => {
    const { params } = createParams({ configOptionKeys: ["thinking"] });
    (params.meta as unknown as { runtimeOptions: Record<string, string> }).runtimeOptions = {
      thinking: "medium",
      model: "gpt-5.5",
    };

    await expect(applyManagerRuntimeControls(params)).rejects.toThrow(
      'does not accept config key "model"',
    );
  });
});
