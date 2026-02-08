# OpenClaw 开发索引

## 运行环境

- **运行进程**: `openclaw-gateway`（PID 由 root 运行）
- **Node 可执行**: `/usr/bin/node`
- **CLI 二进制**: `/usr/bin/openclaw`
- **全局安装路径**: `/usr/lib/node_modules/openclaw/`
- **项目源码路径**: `/home/maxwell/project/openclaw/`
- **当前分支**: `feature/maxwell`
- **Gateway 启动命令**: `sudo bash -c 'nohup /usr/bin/openclaw gateway run --bind loopback --port 18789 --force > /tmp/openclaw-gateway.log 2>&1 &'`
- **Gateway 日志**: `/tmp/openclaw-gateway.log`

## 插件热更新流程

全局安装的插件源码由 jiti 运行时直接加载 `.ts` 文件，无需编译。

1. 修改项目源码 `extensions/<plugin>/src/*.ts`
2. 覆盖到全局: `sudo cp extensions/<plugin>/src/<file>.ts /usr/lib/node_modules/openclaw/extensions/<plugin>/src/<file>.ts`
3. 重启 gateway: `sudo pkill -9 -f openclaw-gateway || true; sleep 1; sudo bash -c 'nohup /usr/bin/openclaw gateway run --bind loopback --port 18789 --force > /tmp/openclaw-gateway.log 2>&1 &'`
4. 验证: `ps aux | grep openclaw-gateway | grep -v grep`

## 飞书扩展 (extensions/feishu)

### 关键文件

| 文件                      | 用途                                           |
| ------------------------- | ---------------------------------------------- |
| `src/send.ts`             | 文本/卡片/Markdown 消息发送                    |
| `src/media.ts`            | 媒体上传/下载/发送（图片、文件、**音频**）     |
| `src/bot.ts`              | 消息接收、解析、媒体类型分发                   |
| `src/client.ts`           | Lark SDK 客户端创建/缓存                       |
| `src/reply-dispatcher.ts` | 回复分发（文本分块、卡片渲染）                 |
| `src/channel.ts`          | 频道注册/事件绑定                              |
| `src/targets.ts`          | receive_id 类型解析（chat_id/open_id/user_id） |
| `src/accounts.ts`         | 多账号配置解析                                 |
| `src/typing.ts`           | 输入状态（reaction 模拟）                      |
| `src/mention.ts`          | @提及 构建                                     |

### 已完成: 音频消息发送支持

- **commit**: `0dda6ac27` on `feature/maxwell`
- **改动文件**: `extensions/feishu/src/media.ts`
- **新增函数**: `sendAudioFeishu()` — 通过 `msg_type: "audio"` 发送可播放语音条
- **新增辅助**: `isAudioFile()` — 检测音频扩展名
- **修改**: `detectFileType()` — 新增 mp3/wav/m4a/aac/flac 识别
- **修改**: `sendMediaFeishu()` — 音频文件路由到 `sendAudioFeishu()` 而非 `sendFileFeishu()`
- **已覆盖到全局**: `/usr/lib/node_modules/openclaw/extensions/feishu/src/media.ts`
