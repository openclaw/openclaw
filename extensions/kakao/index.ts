import type { OpenClawPluginApi } from "openclaw/plugin-sdk/kakao";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk/kakao";
import { kakaoPlugin } from "./src/channel.js";
import { setKakaoRuntime } from "./src/runtime.js";

const plugin = {
  id: "kakao",
  name: "KakaoTalk",
  description: "KakaoTalk channel plugin via Kakao i Open Builder skill server",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    setKakaoRuntime(api.runtime);
    api.registerChannel({ plugin: kakaoPlugin });
  },
};

export default plugin;
