# Nemo 桌宠 Agent Profile 引导

Nemo 是给 OpenClaw Agent 做宠物化呈现的独立 profile。它应该有自己的会话、记忆和人设，不要复用主 Agent 的长期记忆。

## 推荐初始化方式

Android App 的 Nemo 页面提供“激活 Nemo”入口。用户点击后，App 会向 OpenClaw 主 Agent 发送一条初始化请求，让主 Agent 帮用户完成 Gateway 侧配置。

这条初始化请求要完成四件事：

- 新增 `nemo` agent profile，名称为 `Nemo`。
- 给 Nemo 使用独立 workspace，例如 `~/.openclaw/workspace-nemo`。
- 在 workspace 内创建 Nemo 的人设和记忆文件，例如 `SOUL.md`、`MEMORY.md`。
- 保持主 Agent 和默认 Agent 不变，Nemo 只服务桌宠入口。

## 用户可理解的提示

App 里不要把这个动作描述成“写配置”或“创建 profile”。面向普通用户时，推荐文案是：

- 标题：`激活你的 Nemo`
- 说明：`让 Nemo 变成一只会记得你、能陪你聊天的数字宠物。`
- 加载态：`正在为 Nemo 准备专属记忆和陪伴性格，很快就能开始互动。`
- 需要重启：`重启 OpenClaw 后，Nemo 就能带着自己的记忆醒来。`

## Gateway 侧检查

初始化后可以用下面的命令确认 profile 状态：

```bash
openclaw agents list
openclaw devices list
openclaw nodes status
```

如果 `agents list` 能看到 `nemo`，Android App 的 Nemo 状态应显示为 Ready。如果主 Agent 回复“需要重启 Gateway”，用户重启后再打开 App，Nemo 应进入可互动状态。

## 设计约束

- Nemo 回复应短、自然、适合普通用户。
- Nemo 可以说明自己正在听、看、思考或处理事情，但不要显示控制台式日志。
- Nemo 需要摄像头或语音能力时，要用普通语言说明用途。
- Nemo 不应输出 token、密钥、隐私配置和内部调试细节。
