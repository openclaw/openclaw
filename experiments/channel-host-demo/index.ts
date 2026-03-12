/**
 * Channel Host Demo — 主入口
 *
 * 启动流程（对应 openclaw 各模块）：
 *   0. installAgentBridge()          ← 进程内 fetch 拦截，拦截 /v1/chat/completions
 *      DingTalk 等插件不走 onMessage 回调，而是直接调用
 *        fetch("127.0.0.1:18789/v1/chat/completions")
 *      拦截器把这些请求转发给 processMessage()，返回 OpenAI SSE 格式响应，
 *      无需启动真实 Gateway HTTP Server。
 *   1. loadOpenClawConfig()          ← 读取 ~/.openclaw/openclaw.json（含 feishu/dingtalk/qqbot 凭据）
 *   2. loadOpenClawPlugins()         ← src/plugins/loader.ts:447
 *      └── discoverOpenClawPlugins() ← src/plugins/discovery.ts:618
 *          扫描来源（优先级从高到低）：
 *            - pluginsDir (config)   → experiments/channel-host-demo/plugins/
 *            - workspaceDir (workspace) → <openclaw-root>/.openclaw/extensions/
 *            - global               → ~/.openclaw/extensions/
 *   3. startChannelInternal()        ← src/gateway/server-channels.ts:149
 *   4. onMessage → agent.processMessage() → msg.reply()
 *      （demo-channel 等走此路径；DingTalk 走 agent-bridge 路径）
 *
 * 运行方式（直接运行，自动读取 ~/.openclaw/openclaw.json）：
 *   bun run index.ts
 *
 * 运行方式（VSCode，设置 OPENCLAW_ROOT 指向 openclaw 源码目录）：
 *   在 .vscode/launch.json 中添加 "OPENCLAW_ROOT": "/path/to/openclaw"
 *
 * 测试 demo-channel：
 *   curl -X POST http://localhost:3001/message \
 *     -H "Content-Type: application/json" \
 *     -d '{"from": "user1", "text": "hello"}'
 *   # 响应: {"reply":"我知道了"}
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { installAgentBridge } from "./src/agent-bridge.js";
import { processMessage } from "./src/agent.js";
import { startChannelInternal, stopAllChannels } from "./src/plugin-host/lifecycle.js";
import { loadOpenClawPlugins } from "./src/plugin-host/loader.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * 读取 ~/.openclaw/openclaw.json 作为 cfg。
 *
 * openclaw 把所有运行时配置（channels/auth/models/...）存在一个 JSON 文件里，
 * plugin 的 channel.startAccount() 通过 cfg.channels?.["channel-id"] 拿到自己的凭据。
 * 这里直接把整个 JSON 传给 startChannelInternal，与 openclaw 运行时行为一致。
 *
 * 支持环境变量覆盖路径：OPENCLAW_STATE_DIR / CLAWDBOT_STATE_DIR（与 discovery.ts 一致）
 */
// TODO: 将 loadOpenClawConfig 返回类型从 Record<string,unknown> 改为 OpenClawConfig。
// 在 VSCode 中实现时，配置由 VSCode 的 ConfigurationService 提供，类型为 OpenClawConfig。
// demo 阶段直接从 JSON 文件加载，配合 startChannelInternal 的 cfg 参数同步修改：
//   import type { OpenClawConfig } from '../src/config/types.openclaw.js'
//   JSON.parse(raw) as OpenClawConfig  （OpenClawConfig 无运行时校验，类型断言安全）
function loadOpenClawConfig(): Record<string, unknown> {
  const stateDir =
    process.env.OPENCLAW_STATE_DIR?.trim() ||
    process.env.CLAWDBOT_STATE_DIR?.trim() ||
    path.join(os.homedir(), ".openclaw");

  const configPath = path.join(stateDir, "openclaw.json");

  if (fs.existsSync(configPath)) {
    try {
      const raw = fs.readFileSync(configPath, "utf-8");
      const cfg = JSON.parse(raw) as Record<string, unknown>; // TODO: → as OpenClawConfig
      console.log(`[host] config loaded from ${configPath}`);
      return cfg;
    } catch (err) {
      console.warn(`[host] failed to parse ${configPath}:`, err);
    }
  } else {
    console.log(`[host] ${configPath} not found, using minimal demo config`);
  }

  // fallback：最小 demo 配置，只启动 demo-channel
  return {
    channels: {
      "demo-channel": { port: 3001 },
    },
  };
}

async function main() {
  console.log("=== Channel Host Demo starting ===");

  // Step 0：安装进程内 fetch 拦截器
  // DingTalk 等插件会直接调用 fetch("127.0.0.1:18789/v1/chat/completions")，
  // 拦截器把这些请求转发给 processMessage()，返回 OpenAI SSE 格式，
  // 不需要真实 Gateway HTTP Server。
  // 必须在任何插件加载之前调用。
  installAgentBridge();

  // openclaw 工程根目录（workspaceDir），用于扫描 .openclaw/extensions/
  // 对应 openclaw 运行时中 workspaceDir 的概念
  const openclawRoot = path.resolve(__dirname, "../..");

  // 消息处理回调（所有 channel 共用）
  // - demo-channel: 由 lifecycle.ts 的 ctx.onMessage 注入（见 Step 3）
  // - qqbot: 由 api.runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher 调用（见 loader.ts）
  // - DingTalk: 由 agent-bridge.ts 的 fetch 拦截器调用（见 Step 0）
  const handleMessage = async (msg: Parameters<typeof processMessage>[0]) => {
    const reply = await processMessage(msg);
    await msg.reply(reply);
  };

  // Step 1 + 2：探索并加载插件（discover → load → register）
  // 扫描顺序：pluginsDir(config) → workspaceDir/.openclaw/extensions → ~/.openclaw/extensions(global)
  // onMessage 注入到 api.runtime，供 qqbot 等通过 pluginRuntime 调用的插件使用
  const result = loadOpenClawPlugins({
    pluginsDir: path.join(__dirname, "plugins"),
    workspaceDir: openclawRoot,
    onMessage: handleMessage,
  });

  console.log(`\n[host] loaded ${result.summary()}`);

  if (result.channels.length === 0) {
    console.error("[host] no channels registered, exiting");
    process.exit(1);
  }

  // channel 配置（从 ~/.openclaw/openclaw.json 读取，包含 feishu/dingtalk/qqbot 凭据）
  // 结构对应 openclaw OpenClawConfig：cfg.channels?.["feishu"] / cfg.channels?.["qqbot"] 等
  // demo-channel 额外追加进 channels，确保它总是可启动
  const cfg = loadOpenClawConfig();
  const channels = (cfg.channels as Record<string, unknown>) ?? {};
  if (!channels["demo-channel"]) {
    channels["demo-channel"] = { port: 3001 };
  }
  cfg.channels = channels;

  // Step 3：并行启动所有已注册的 channel
  // 对应 openclaw server-channels.ts：所有 channel 并发启动，不互相阻塞
  // startChannelInternal 的 await 仅等到 startAccount() 返回（连接建立），
  // 长连接本身在后台继续运行。
  const startPromises = result.channels.map(({ plugin }) => {
    console.log(`\n[host] starting channel: ${plugin.id}`);
    return startChannelInternal(
      plugin,
      cfg,
      // Step 4：消息回调 — 收到消息 → agent 处理 → 回复
      // demo-channel 等走此路径；qqbot 走 runtime.channel.reply 路径；DingTalk 走 agent-bridge 路径
      handleMessage,
      // channelRuntime：注入到 ctx.channelRuntime，供新式插件通过 ChannelGatewayContext 调用
      result.channelRuntime,
    ).catch((err) => {
      // 单个 channel 启动失败不影响其他 channel
      console.error(`[host] channel "${plugin.id}" failed to start:`, err);
    });
  });

  await Promise.all(startPromises);

  console.log("\n=== Channel Host Demo ready ===");
  console.log("Send a message:");
  console.log(
    `  curl -X POST http://localhost:3001/message -H "Content-Type: application/json" -d '{"from":"user1","text":"hello"}'`,
  );
  console.log("");

  // 优雅退出
  const shutdown = () => {
    console.log("\n[host] shutting down...");
    stopAllChannels();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("[host] fatal error:", err);
  process.exit(1);
});
