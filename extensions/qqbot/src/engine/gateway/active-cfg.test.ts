import { describe, expect, it, vi } from "vitest";
import {
  createActiveCfgProvider,
  resolveActiveCfg,
  type GatewayCfg,
  type GatewayCfgLoader,
} from "./active-cfg.js";

const getRuntimeConfigMock = vi.hoisted(() => vi.fn<() => GatewayCfg | undefined>());

vi.mock("openclaw/plugin-sdk/runtime-config-snapshot", () => ({
  getRuntimeConfig: getRuntimeConfigMock,
}));

describe("resolveActiveCfg", () => {
  it("returns the freshly fetched value when present", () => {
    const fresh = { bindings: [{ id: "fresh" }] };
    const fallback = { bindings: [{ id: "stale" }] };
    const load: GatewayCfgLoader = () => fresh;

    expect(resolveActiveCfg(load, fallback)).toBe(fresh);
  });

  it("falls back when the loader returns undefined", () => {
    const fallback = { bindings: [{ id: "stale" }] };
    const load: GatewayCfgLoader = () => undefined;

    expect(resolveActiveCfg(load, fallback)).toBe(fallback);
  });

  it("falls back when the loader throws", () => {
    const fallback = { bindings: [{ id: "stale" }] };
    const load: GatewayCfgLoader = () => {
      throw new Error("snapshot not initialised");
    };

    expect(resolveActiveCfg(load, fallback)).toBe(fallback);
  });
});

describe("createActiveCfgProvider", () => {
  it("invokes the injected loader on every getActiveCfg call", () => {
    const fallback = { bindings: [] };
    const first = { bindings: [{ id: "first" }] };
    const second = { bindings: [{ id: "second" }] };
    const load = vi
      .fn<() => GatewayCfg | undefined>()
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(second);

    const provider = createActiveCfgProvider({ fallback, load });

    expect(provider.getActiveCfg()).toBe(first);
    expect(provider.getActiveCfg()).toBe(second);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("never caches a previously fetched value", () => {
    const fallback = { bindings: [] };
    const calls: GatewayCfg[] = [
      { bindings: [{ id: "a" }] },
      { bindings: [{ id: "b" }] },
      { bindings: [{ id: "c" }] },
    ];
    let index = 0;
    const provider = createActiveCfgProvider({
      fallback,
      load: () => calls[index++],
    });

    expect(provider.getActiveCfg()).toBe(calls[0]);
    expect(provider.getActiveCfg()).toBe(calls[1]);
    expect(provider.getActiveCfg()).toBe(calls[2]);
  });

  it("delegates to getRuntimeConfig when no fetcher is provided", () => {
    const live = { bindings: [{ id: "live" }] };
    getRuntimeConfigMock.mockReset();
    getRuntimeConfigMock.mockReturnValue(live);

    const provider = createActiveCfgProvider({ fallback: { bindings: [] } });

    expect(provider.getActiveCfg()).toBe(live);
    expect(getRuntimeConfigMock).toHaveBeenCalledTimes(1);
  });

  it("falls back to the supplied snapshot when the SDK getter throws", () => {
    const fallback = { bindings: [{ id: "snapshot" }] };
    getRuntimeConfigMock.mockReset();
    getRuntimeConfigMock.mockImplementation(() => {
      throw new Error("not ready");
    });

    const provider = createActiveCfgProvider({ fallback });

    expect(provider.getActiveCfg()).toBe(fallback);
  });
});
