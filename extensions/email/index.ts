import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { emailPlugin } from "./src/channel.js";
import { setEmailRuntime } from "./src/runtime.js";
import { createEmailInboundHandler } from "./src/inbound.js";

const plugin = {
  id: "email",
  name: "Email",
  description: "Email channel plugin for American Claw managed hosting",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    setEmailRuntime(api.runtime);

    api.registerChannel({ plugin: emailPlugin });

    // Register the gateway RPC method that American Claw calls
    // when an inbound email arrives via Cloudflare Email Routing.
    api.registerGatewayMethod(
      "email.inbound",
      createEmailInboundHandler(),
    );
  },
};

export default plugin;
