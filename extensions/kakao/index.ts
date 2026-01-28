import type { MoltbotPluginApi } from "clawdbot/plugin-sdk";
import { emptyPluginConfigSchema } from "clawdbot/plugin-sdk";

import { kakaoDock, kakaoPlugin } from "./src/channel.js";
import { handleKakaoCallbackRequest } from "./src/monitor.js";
import { setKakaoRuntime } from "./src/runtime.js";

const plugin = {
  id: "kakao",
  name: "KakaoWork",
  description: "KakaoWork channel plugin (Bot API)",
  configSchema: emptyPluginConfigSchema(),
  register(api: MoltbotPluginApi) {
    setKakaoRuntime(api.runtime);
    api.registerChannel({ plugin: kakaoPlugin, dock: kakaoDock });
    api.registerHttpHandler(handleKakaoCallbackRequest);
  },
};

export default plugin;
