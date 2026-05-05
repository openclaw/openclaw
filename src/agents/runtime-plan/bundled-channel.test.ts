import { describe, it, expect } from "vitest";
import {
  createBundledChannelAdapterRegistry,
  registerBundledChannelAdapter,
  getBundledChannelAdapter,
  listBundledChannelAdapters,
  type BundledChannelOutboundAdapter,
} from "./bundled-channel";

describe("bundled channel outbound adapter", () => {
  it("creates empty registry", () => {
    const registry = createBundledChannelAdapterRegistry();
    expect(registry.size).toBe(0);
  });

  it("registers and retrieves adapter", () => {
    const registry = createBundledChannelAdapterRegistry();
    const adapter: BundledChannelOutboundAdapter = {
      id: "telegram-v1",
      version: "1.0.0",
      supports: ["text", "media"],
    };

    registerBundledChannelAdapter(registry, adapter);

    const retrieved = getBundledChannelAdapter(registry, "telegram-v1");
    expect(retrieved).toEqual(adapter);
  });

  it("returns undefined for missing adapter", () => {
    const registry = createBundledChannelAdapterRegistry();
    const retrieved = getBundledChannelAdapter(registry, "missing");
    expect(retrieved).toBeUndefined();
  });

  it("lists all registered adapters", () => {
    const registry = createBundledChannelAdapterRegistry();
    const adapters: BundledChannelOutboundAdapter[] = [
      { id: "telegram-v1", version: "1.0.0", supports: ["text"] },
      { id: "discord-v1", version: "1.0.0", supports: ["text", "media"] },
      { id: "slack-v1", version: "1.0.0", supports: ["text", "interactive"] },
    ];

    for (const adapter of adapters) {
      registerBundledChannelAdapter(registry, adapter);
    }

    const listed = listBundledChannelAdapters(registry);
    expect(listed).toHaveLength(3);
    expect(listed).toContainEqual(adapters[0]);
    expect(listed).toContainEqual(adapters[1]);
    expect(listed).toContainEqual(adapters[2]);
  });

  it("handles multiple registrations", () => {
    const registry = createBundledChannelAdapterRegistry();
    const adapter1: BundledChannelOutboundAdapter = {
      id: "channel-1",
      version: "1.0.0",
      supports: ["text"],
    };
    const adapter2: BundledChannelOutboundAdapter = {
      id: "channel-2",
      version: "2.0.0",
      supports: ["text", "media"],
    };

    registerBundledChannelAdapter(registry, adapter1);
    registerBundledChannelAdapter(registry, adapter2);

    expect(registry.size).toBe(2);
    expect(getBundledChannelAdapter(registry, "channel-1")).toEqual(adapter1);
    expect(getBundledChannelAdapter(registry, "channel-2")).toEqual(adapter2);
  });
});
