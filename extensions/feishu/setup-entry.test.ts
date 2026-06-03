import { afterAll, describe, expect, it, vi } from "vitest";

vi.mock("@larksuiteoapi/node-sdk", () => {
  throw new Error("setup entry must not load the Feishu SDK");
});

describe("feishu setup entry", () => {
  afterAll(() => {
    vi.doUnmock("@larksuiteoapi/node-sdk");
    vi.resetModules();
  });

  it("declares the setup entry without importing Feishu runtime dependencies", async () => {
    const { default: setupEntry } = await import("./setup-entry.js");

    expect(setupEntry.kind).toBe("bundled-channel-setup-entry");
    expect(setupEntry.features).toEqual({ legacyStateMigrations: true });
    expect(typeof setupEntry.loadSetupPlugin).toBe("function");
    expect(setupEntry.loadLegacyStateMigrationDetector?.()).toBeTypeOf("function");
    expect(typeof setupEntry.setChannelRuntime).toBe("function");
  });

  it("wires the Feishu runtime from setup-only registration", async () => {
    const { default: setupEntry } = await import("./setup-entry.js");
    const runtime = { channel: { inbound: { run: vi.fn() } } };

    setupEntry.setChannelRuntime?.(runtime as never);

    const { getFeishuRuntime } = await import("./src/runtime.js");
    expect(getFeishuRuntime()).toBe(runtime);
  });

  it("wires the Feishu runtime through the setup-loader registration path", async () => {
    const { default: setupEntry } = await import("./setup-entry.js");
    const { resolveSetupChannelRegistration } =
      await import("../../src/plugins/loader-channel-setup.js");
    const runtime = { channel: { inbound: { run: vi.fn() } } };

    const registration = resolveSetupChannelRegistration({
      default: {
        kind: setupEntry.kind,
        loadSetupPlugin: () => ({ id: "feishu" }),
        setChannelRuntime: setupEntry.setChannelRuntime,
      },
    });

    expect(registration.usesBundledSetupContract).toBe(true);
    expect(registration.plugin?.id).toBe("feishu");
    expect(typeof registration.setChannelRuntime).toBe("function");

    registration.setChannelRuntime?.(runtime as never);

    const { getFeishuRuntime } = await import("./src/runtime.js");
    expect(getFeishuRuntime()).toBe(runtime);
  });
});
