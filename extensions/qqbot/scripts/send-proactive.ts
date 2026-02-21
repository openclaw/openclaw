#!/usr/bin/env npx ts-node
/**
 * QQBot 主动消息 CLI 工具
 *
 * 使用示例：
 *   # 发送私聊消息
 *   npx ts-node scripts/send-proactive.ts --to "用户openid" --text "你好！"
 *
 *   # 发送群聊消息
 *   npx ts-node scripts/send-proactive.ts --to "群组openid" --type group --text "群公告"
 *
 *   # 列出已知用户
 *   npx ts-node scripts/send-proactive.ts --list
 *
 *   # 列出群聊用户
 *   npx ts-node scripts/send-proactive.ts --list --type group
 *
 *   # 广播消息
 *   npx ts-node scripts/send-proactive.ts --broadcast --text "系统公告" --type c2c --limit 10
 */

import type { OpenClawConfig } from "openclaw/plugin-sdk";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ResolvedQQBotAccount } from "../src/types.js";
import {
  sendProactiveMessageDirect,
  listKnownUsers,
  getKnownUsersStats,
  broadcastMessage,
} from "../src/proactive.js";

// 解析命令行参数
function parseArgs(): Record<string, string | boolean> {
  const args: Record<string, string | boolean> = {};
  const argv = process.argv.slice(2);

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const nextArg = argv[i + 1];
      if (nextArg && !nextArg.startsWith("--")) {
        args[key] = nextArg;
        i++;
      } else {
        args[key] = true;
      }
    }
  }

  return args;
}

// 从配置文件加载账户信息
function loadAccount(accountId = "default"): ResolvedQQBotAccount | null {
  const configPath = path.join(process.env.HOME || "/home/ubuntu", "clawd", "config.json");

  try {
    if (!fs.existsSync(configPath)) {
      // 尝试从环境变量获取
      const appId = process.env.QQBOT_APP_ID;
      const clientSecret = process.env.QQBOT_CLIENT_SECRET;

      if (appId && clientSecret) {
        return {
          accountId,
          appId,
          clientSecret,
          enabled: true,
          secretSource: "env",
        };
      }

      console.error("配置文件不存在且环境变量未设置");
      return null;
    }

    const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    const qqbot = config.channels?.qqbot;

    if (!qqbot) {
      console.error("配置中没有 qqbot 配置");
      return null;
    }

    // 解析账户配置
    if (accountId === "default") {
      return {
        accountId: "default",
        appId: qqbot.appId || process.env.QQBOT_APP_ID,
        clientSecret: qqbot.clientSecret || process.env.QQBOT_CLIENT_SECRET,
        enabled: qqbot.enabled ?? true,
        secretSource: qqbot.clientSecret ? "config" : "env",
      };
    }

    const accountConfig = qqbot.accounts?.[accountId];
    if (accountConfig) {
      return {
        accountId,
        appId: accountConfig.appId || qqbot.appId || process.env.QQBOT_APP_ID,
        clientSecret:
          accountConfig.clientSecret || qqbot.clientSecret || process.env.QQBOT_CLIENT_SECRET,
        enabled: accountConfig.enabled ?? true,
        secretSource: accountConfig.clientSecret ? "config" : "env",
      };
    }

    console.error(`账户 ${accountId} 不存在`);
    return null;
  } catch (err) {
    console.error(`加载配置失败: ${err}`);
    return null;
  }
}

async function main() {
  const args = parseArgs();

  // 显示帮助
  if (args.help || args.h) {
    console.log(`
QQBot 主动消息 CLI 工具

用法:
  npx ts-node scripts/send-proactive.ts [选项]

选项:
  --to <openid>      目标用户或群组的 openid
  --text <message>   要发送的消息内容
  --type <type>      消息类型: c2c (私聊) 或 group (群聊)，默认 c2c
  --account <id>     账户 ID，默认 default
  
  --list             列出已知用户
  --stats            显示用户统计
  --broadcast        广播消息给所有已知用户
  --limit <n>        限制数量
  
  --help, -h         显示帮助

示例:
  # 发送私聊消息
  npx ts-node scripts/send-proactive.ts --to "0Eda5EA7-xxx" --text "你好！"
  
  # 发送群聊消息
  npx ts-node scripts/send-proactive.ts --to "A1B2C3D4" --type group --text "群公告"
  
  # 列出最近 10 个私聊用户
  npx ts-node scripts/send-proactive.ts --list --type c2c --limit 10
  
  # 广播消息
  npx ts-node scripts/send-proactive.ts --broadcast --text "系统公告" --limit 5
`);
    return;
  }

  const accountId = (args.account as string) || "default";
  const type = (args.type as "c2c" | "group") || "c2c";
  const limit = args.limit ? parseInt(args.limit as string, 10) : undefined;

  // 列出已知用户
  if (args.list) {
    const users = listKnownUsers({
      type: args.type as "c2c" | "group" | "channel" | undefined,
      accountId: args.account as string | undefined,
      limit,
    });

    if (users.length === 0) {
      console.log("没有已知用户");
      return;
    }

    console.log(`\n已知用户列表 (共 ${users.length} 个):\n`);
    console.log("类型\t\tOpenID\t\t\t\t\t\t昵称\t\t最后交互时间");
    console.log("─".repeat(100));

    for (const user of users) {
      const lastTime = new Date(user.lastInteractionAt).toLocaleString();
      console.log(
        `${user.type}\t\t${user.openid.slice(0, 20)}...\t${user.nickname || "-"}\t\t${lastTime}`,
      );
    }
    return;
  }

  // 显示统计
  if (args.stats) {
    const stats = getKnownUsersStats(args.account as string | undefined);
    console.log(`\n用户统计:`);
    console.log(`  总计: ${stats.total}`);
    console.log(`  私聊: ${stats.c2c}`);
    console.log(`  群聊: ${stats.group}`);
    console.log(`  频道: ${stats.channel}`);
    return;
  }

  // 广播消息
  if (args.broadcast) {
    if (!args.text) {
      console.error("请指定消息内容 (--text)");
      process.exit(1);
    }

    // 加载配置用于广播
    const configPath = path.join(process.env.HOME || "/home/ubuntu", "clawd", "config.json");
    let cfg: Record<string, unknown> = {};
    try {
      if (fs.existsSync(configPath)) {
        cfg = JSON.parse(fs.readFileSync(configPath, "utf-8"));
      }
    } catch {}

    console.log(`\n开始广播消息...\n`);
    const result = await broadcastMessage(args.text as string, cfg as OpenClawConfig, {
      type,
      accountId,
      limit,
    });

    console.log(`\n广播完成:`);
    console.log(`  发送总数: ${result.total}`);
    console.log(`  成功: ${result.success}`);
    console.log(`  失败: ${result.failed}`);

    if (result.failed > 0) {
      console.log(`\n失败详情:`);
      for (const r of result.results) {
        if (!r.result.success) {
          console.log(`  ${r.to}: ${r.result.error}`);
        }
      }
    }
    return;
  }

  // 发送单条消息
  if (args.to && args.text) {
    const account = loadAccount(accountId);
    if (!account) {
      console.error("无法加载账户配置");
      process.exit(1);
    }

    console.log(`\n发送消息...`);
    console.log(`  目标: ${args.to}`);
    console.log(`  类型: ${type}`);
    console.log(`  内容: ${args.text}`);

    const result = await sendProactiveMessageDirect(
      account,
      args.to as string,
      args.text as string,
      type,
    );

    if (result.success) {
      console.log(`\n✅ 发送成功!`);
      console.log(`  消息ID: ${result.messageId}`);
      console.log(`  时间戳: ${result.timestamp}`);
    } else {
      console.log(`\n❌ 发送失败: ${result.error}`);
      process.exit(1);
    }
    return;
  }

  // 没有有效参数
  console.error("请指定操作。使用 --help 查看帮助。");
  process.exit(1);
}

main().catch((err) => {
  console.error(`执行失败: ${err}`);
  process.exit(1);
});
