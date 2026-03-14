import { createPluginRuntimeStore } from "openclaw/plugin-sdk/compat";
import type { PluginRuntime } from "openclaw/plugin-sdk/twilio-sms";

const { setRuntime: setTwilioSmsRuntime, getRuntime: getTwilioSmsRuntime } =
  createPluginRuntimeStore<PluginRuntime>(
    "Twilio SMS runtime not initialized - plugin not registered",
  );
export { getTwilioSmsRuntime, setTwilioSmsRuntime };
