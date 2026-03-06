/**
 * Open-ClawChat Channel Plugin
 */

import type { OpenClawPluginApi, ChannelPlugin } from "openclaw/plugin-sdk"
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk"
import { openClawChatPlugin } from "./src/channel.js"
import { setOpenClawChatRuntime } from "./src/runtime.js"

const plugin = {
  id: "open-clawchat",
  name: "Open-ClawChat",
  description: "Open-ClawChat real-time chat integration via WebSocket/Webhook",
  configSchema: emptyPluginConfigSchema(),

  register(api: OpenClawPluginApi) {
    // Set runtime for internal use (message handling, etc.)
    setOpenClawChatRuntime(api.runtime)

    // Register the channel plugin
    api.registerChannel({ plugin: openClawChatPlugin as ChannelPlugin })
    console.log("[Open-ClawChat] Plugin registered")
  },
}

export default plugin

// 导出子模块
export { openClawChatPlugin } from "./src/channel.js"
export { OpenClawChatAPIClient } from "./src/api-client.js"
export { OpenClawChatWSClient } from "./src/websocket-client.js"
export { WebhookServer } from "./src/webhook-server.js"
export * from "./src/types.js"
