# 钉钉插件图片处理功能修复总结

## 背景

钉钉（DingTalk）渠道无法解析富文本消息中的图片和纯图片消息。表现为：

- 发送富文本消息时，OpenClaw 收到 `[富文本消息]` 占位符
- 发送图片时收到 `[图片]` 占位符
- 官方仓库（`DingTalk-Real-AI/dingtalk-moltbot-connector`）同样存在此问题（Issue #54 未修复）

## 变更文件

所有修改均在 OpenClaw 源码仓库之外，不被 git 跟踪：

| 文件            | 位置                                         | 说明                       |
| --------------- | -------------------------------------------- | -------------------------- |
| `plugin.ts`     | `~/.openclaw/extensions/dingtalk-connector/` | 钉钉插件（本地安装的扩展） |
| `openclaw.json` | `~/.openclaw/`                               | Gateway 运行时配置         |

## 修改内容

### 1. 新增 `downloadDingTalkImage` 函数

通过钉钉 API 下载图片到本地临时文件：

- 接口：`POST https://api.dingtalk.com/v1.0/robot/messageFiles/download`
- 参数：`{ downloadCode, robotCode }` + `x-acs-dingtalk-access-token` header
- 下载到 `/tmp/dingtalk-images/dt-img-{timestamp}-{random}.jpg`
- 带 3 次重试 + 递增退避（应对转发消息等瞬时失败场景）

### 2. 重构 `extractMessageContent` 函数

- 从同步改为 `async`
- 返回类型扩展为 `{ text, messageType, imagePaths[] }`
- 适配钉钉实际 richText 数据结构（关键修复见下方"踩坑记录"）
- 图片下载失败时追加 `[图片加载失败，请重新发送图片]` 到文本

### 3. 修改 `handleDingTalkMessage` 函数

- 将 `imagePaths` 转为 `[Image: source: /path]` 格式拼接到 `userContent`
- 纯图片（无文字）使用中性提示 `[用户发送了图片]`
- 两处 `streamFromGateway` 调用参数从 `content.text` 改为 `userContent`

### 4. 新增 VL 模型配置（`openclaw.json`）

`models.providers.bailian.models` 新增：

```json
{
  "id": "qwen3-vl-plus",
  "name": "Qwen3 VL Plus",
  "input": ["text", "image"],
  "contextWindow": 128000,
  "maxTokens": 8192
}
```

`agents.defaults.imageModel` 新增：

```json
{ "primary": "bailian/qwen3-vl-plus" }
```

工作流变为：主文本对话用 `qwen3-max`，图片理解由 agent 的 image tool 自动调用 `qwen3-vl-plus`。

## 踩坑记录

### 1. richText 数据结构与文档不符

钉钉实际的 richText 数组 item **没有 `type` 字段**：

```
预期: { type: "text", text: "..." } / { type: "picture", downloadCode: "..." }
实际: { text: "..." }              / { pictureDownloadCode: "..." }
```

字段名也不同：图片用的是 `pictureDownloadCode`（不是 `downloadCode`）。

### 2. 转发消息图片下载失败

当消息为转发（`isForwardMsg: "1"`）时，钉钉 robot file download API 对其中的 `pictureDownloadCode` 返回 HTTP 500：

```
resp={"code":"unknownError","message":"未知错误"}
```

这是钉钉服务端的限制。解决方案：添加重试 + 下载失败时给出明确提示文本。

### 3. 模型不支持 vision

初始使用 `qwen3-max`（纯文本模型），agent 通过 `read` 工具读取图片 base64 后，模型无法理解图片内容，陷入循环调用。解决方案：新增 `qwen3-vl-plus` 作为 imageModel。

### 4. Gateway 重启进程冲突

`pnpm openclaw gateway restart` 启动了 systemd 服务，但旧的 nohup 进程仍占用 18789 端口。需手动 kill 旧进程后重新启动。

### 5. jiti 缓存

TypeScript 插件通过 jiti 编译并缓存在 `/tmp/jiti/`。修改 plugin.ts 后需清除缓存（`rm /tmp/jiti/dingtalk-connector-plugin.*.cjs`）并重启 gateway 才能生效。

## 整体链路

```
钉钉用户发送富文本(文字+图片)
  → DingTalk Stream 回调
  → extractMessageContent() 解析 richText
    → 提取文字 (part.text)
    → 下载图片 (part.pictureDownloadCode → downloadDingTalkImage)
  → handleDingTalkMessage() 拼接 userContent
    → "用户文字\n\n[Image: source: /tmp/xxx.jpg]"
  → streamFromGateway() 发送到 Gateway
  → Agent Runner 检测 [Image: source: ...] 引用
  → image tool 调用 qwen3-vl-plus 描述图片
  → qwen3-max 基于文字+图片描述生成最终回复
  → AI Card 流式回复到钉钉
```
