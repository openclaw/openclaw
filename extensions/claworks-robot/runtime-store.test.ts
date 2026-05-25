import type { ClaworksRuntime } from "@claworks/runtime";
import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it } from "vitest";
import type { ClaworksBridge } from "./bridge.js";
import {
  clearClaworksRobotRuntimeStore,
  getClaworksRobotBridge,
  getClaworksRobotRuntime,
  resetClaworksRobotRuntimeStoreForTest,
  setClaworksRobotBridge,
  setClaworksRobotRuntime,
} from "./runtime-store.js";

describe("claworks-robot runtime-store", () => {
  afterEach(() => {
    resetClaworksRobotRuntimeStoreForTest();
  });

  it("shares runtime and bridge across duplicate module instances (double register contract)", async () => {
    const firstModule = await importFreshModule<typeof import("./runtime-store.js")>(
      import.meta.url,
      "./runtime-store.js?scope=claworks-robot-store-a",
    );
    const secondModule = await importFreshModule<typeof import("./runtime-store.js")>(
      import.meta.url,
      "./runtime-store.js?scope=claworks-robot-store-b",
    );

    const runtime = { robot: { name: "shared" } } as unknown as ClaworksRuntime;
    const bridge = { notify: async () => undefined } as unknown as ClaworksBridge;

    firstModule.setClaworksRobotRuntime(runtime);
    firstModule.setClaworksRobotBridge(bridge);

    expect(secondModule.getClaworksRobotRuntime()).toBe(runtime);
    expect(secondModule.getClaworksRobotBridge()).toBe(bridge);
  });

  it("clearClaworksRobotRuntimeStore drops references and removes the global slot", () => {
    setClaworksRobotRuntime({ robot: { name: "temp" } } as unknown as ClaworksRuntime);
    setClaworksRobotBridge({ notify: async () => undefined } as unknown as ClaworksBridge);

    clearClaworksRobotRuntimeStore();

    expect(getClaworksRobotRuntime()).toBeNull();
    expect(getClaworksRobotBridge()).toBeNull();
    expect(
      (globalThis as Record<symbol, unknown>)[Symbol.for("claworks-robot.runtime-store")],
    ).toBeUndefined();
  });
});
