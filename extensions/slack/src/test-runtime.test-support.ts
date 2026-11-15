import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import { setSlackRuntime } from "./runtime.js";

export function installSlackTestRuntime(overrides?: Parameters<typeof createPluginRuntimeMock>[0]) {
  const runtime = createPluginRuntimeMock(overrides);
  setSlackRuntime(runtime);
  return runtime;
}
