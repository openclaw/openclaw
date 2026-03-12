/**
 * Demo Channel — 插件入口（register 函数）
 *
 * 对应 openclaw extensions/irc/index.ts 的结构：
 *   export default {
 *     id: "irc",
 *     register(api: OpenClawPluginApi) {
 *       api.registerChannel({ plugin: ircPlugin });
 *     },
 *   };
 *
 * openclaw loader 发现此文件后会调用 register(api)，
 * 插件通过 api.registerChannel() 将 channel 注册到 Host 的 PluginRegistry。
 */

import type { OpenClawPluginApi } from "../../src/types.js";
import { demoChannelPlugin } from "./channel.js";

export default {
  id: "demo-channel",
  name: "Demo HTTP Channel",

  register(api: OpenClawPluginApi) {
    // 对应 openclaw extensions/irc/index.ts:
    //   api.registerChannel({ plugin: ircPlugin });
    api.registerChannel({ plugin: demoChannelPlugin });
  },
};
