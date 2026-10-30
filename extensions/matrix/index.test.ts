import type { OpenClawPluginApi } from "openclaw/plugin-sdk/channel-entry-contract";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { assert, describe, expect, it, vi } from "vitest";
import entry, { registerMatrixFullRuntime } from "./index.js";

const cliMocks = vi.hoisted(() => ({ registerMatrixCli: vi.fn() }));

const runtimeMocks = vi.hoisted(() => ({
  ensureMatrixCryptoRuntime: vi.fn(async () => {}),
  handleMatrixSubagentDeliveryTarget: vi.fn(() => "delivery-target"),
  handleMatrixSubagentEnded: vi.fn(async () => {}),
  setMatrixRuntime: vi.fn(),
}));

// mock-isolation: Keep the real account/device CLI runtime out of descriptor registration tests.
vi.mock("./src/cli.js", () => cliMocks);

vi.mock("./plugin-entry.handlers.runtime.js", () => runtimeMocks);
vi.mock("./runtime-setter-api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./runtime-setter-api.js")>()),
  setMatrixRuntime: runtimeMocks.setMatrixRuntime,
}));
vi.mock("./src/matrix/subagent-hooks.js", () => runtimeMocks);

describe("matrix plugin", () => {
  it("registers matrix CLI through a descriptor-backed lazy registrar", async () => {
    const registerCli = vi.fn<OpenClawPluginApi["registerCli"]>();
    const registerGatewayMethod = vi.fn();
    entry.register(
      createTestPluginApi({
        id: "matrix",
        registrationMode: "cli-metadata",
        registerCli,
        registerGatewayMethod,
      }),
    );

    expect(registerCli).toHaveBeenCalledTimes(1);
    const [registration] = registerCli.mock.calls;
    assert.isDefined(registration);
    const [registrar, options] = registration;
    expect(typeof registrar).toBe("function");
    expect(options).toEqual({
      descriptors: [
        {
          name: "matrix",
          description: "Manage Matrix accounts, verification, devices, and profile state",
          hasSubcommands: true,
        },
      ],
    });
    expect(cliMocks.registerMatrixCli).not.toHaveBeenCalled();

    const program = { command: vi.fn() };
    await registrar({ program } as never);
    expect(cliMocks.registerMatrixCli).toHaveBeenCalledWith({ program });
    expect(registerGatewayMethod).not.toHaveBeenCalled();
  });

  it("keeps runtime bootstrap and CLI metadata out of setup-only registration", () => {
    if (!entry.setChannelRuntime) {
      throw new Error("expected Matrix runtime setter");
    }
    entry.setChannelRuntime({ marker: "runtime" } as never);
    expect(runtimeMocks.setMatrixRuntime).not.toHaveBeenCalled();
  });

  it("registers subagent lifecycle hooks during full runtime registration", async () => {
    const on = vi.fn();
    registerMatrixFullRuntime(createTestPluginApi({ id: "matrix", on }));

    expect(runtimeMocks.ensureMatrixCryptoRuntime).not.toHaveBeenCalled();
    expect(on.mock.calls.map(([hookName]) => hookName)).toEqual([
      "subagent_ended",
      "subagent_delivery_target",
    ]);
    const handlers = Object.fromEntries(on.mock.calls);
    await expect(handlers.subagent_ended({ id: "ended" })).resolves.toBeUndefined();
    await expect(handlers.subagent_delivery_target({ id: "target" })).resolves.toBe(
      "delivery-target",
    );
    expect(runtimeMocks.handleMatrixSubagentEnded).toHaveBeenCalledWith({ id: "ended" });
    expect(runtimeMocks.handleMatrixSubagentDeliveryTarget).toHaveBeenCalledWith({ id: "target" });
  });
});
