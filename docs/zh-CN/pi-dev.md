---
read_when:
  - 在 OpenClaw 中处理 Pi 集成代码或测试时
  - 运行 Pi 专用的代码规范检查、类型检查和实时测试流程时
summary: Pi 集成的开发工作流：构建、测试和实时验证
title: Pi 开发工作流
x-i18n:
  generated_at: "2026-03-29T04:06:57Z"
  model: gpt-5.4
  provider: openai
  source_hash: 7be1c0f9ecf4315115b2e8188f7472eebba2a8424296661184a02bf5ad6e90c5
  source_path: pi-dev.md
  workflow: 15
---

# Pi 开发工作流

本指南总结了在 OpenClaw 中处理 Pi 集成时的一套合理工作流。

## 类型检查与代码规范检查

- 类型检查和构建：`pnpm build`
- 代码规范检查：`pnpm lint`
- 格式检查：`pnpm format`
- 推送前的完整检查：`pnpm lint && pnpm build && pnpm test`

## 运行 Pi 测试

直接使用 Vitest 运行面向 Pi 的测试集：

```bash
pnpm test -- \
  "src/agents/pi-*.test.ts" \
  "src/agents/pi-embedded-*.test.ts" \
  "src/agents/pi-tools*.test.ts" \
  "src/agents/pi-settings.test.ts" \
  "src/agents/pi-tool-definition-adapter*.test.ts" \
  "src/agents/pi-hooks/**/*.test.ts"
```

如果还要包含提供商的实时演练：

```bash
OPENCLAW_LIVE_TEST=1 pnpm test -- src/agents/pi-embedded-runner-extraparams.live.test.ts
```

这涵盖了主要的 Pi 单元测试套件：

- `src/agents/pi-*.test.ts`
- `src/agents/pi-embedded-*.test.ts`
- `src/agents/pi-tools*.test.ts`
- `src/agents/pi-settings.test.ts`
- `src/agents/pi-tool-definition-adapter.test.ts`
- `src/agents/pi-hooks/*.test.ts`

## 手动测试

推荐流程：

- 以开发模式运行 Gateway 网关：
  - `pnpm gateway:dev`
- 直接触发智能体：
  - `pnpm openclaw agent --message "Hello" --thinking low`
- 使用终端界面进行交互式调试：
  - `pnpm tui`

对于工具调用行为，请提示执行 `read` 或 `exec` 操作，这样你就可以看到工具的流式传输和负载处理。

## 彻底重置

状态存储在 OpenClaw 状态目录下。默认路径是 `~/.openclaw`。如果设置了 `OPENCLAW_STATE_DIR`，则改用该目录。

如需重置全部内容：

- `openclaw.json` 用于配置
- `credentials/` 用于凭证配置文件和令牌
- `agents/<agentId>/sessions/` 用于智能体会话历史
- `agents/<agentId>/sessions.json` 用于会话索引
- `sessions/`，如果存在旧版路径
- `workspace/`，如果你想要一个空白工作区

如果你只想重置会话，请删除该智能体的 `agents/<agentId>/sessions/` 和 `agents/<agentId>/sessions.json`。如果你不想重新进行身份验证，请保留 `credentials/`。

## 参考资料

- [测试](/help/testing)
- [入门指南](/start/getting-started)
