import type { OpenClawPluginApi } from "openclaw/plugin-sdk/twilio-sms";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk/twilio-sms";
import { twilioSmsPlugin } from "./src/channel.js";
import { setTwilioSmsRuntime } from "./src/runtime.js";

const plugin = {
  id: "twilio-sms",
  name: "Twilio SMS",
  description: "Twilio SMS/MMS channel plugin",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    setTwilioSmsRuntime(api.runtime);
    api.registerChannel({ plugin: twilioSmsPlugin });
  },
};

export default plugin;
