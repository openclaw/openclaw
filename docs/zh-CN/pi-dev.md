---
title: Pi 开发工作流程
x-i18n:
  generated_at: "2026-02-03T10:07:59Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: 65bd0580dd03df05321ced35a036ce6fb815ce3ddac1d35c9976279adcbf87c0
  source_path: pi-dev.md
  workflow: 15
---

# Pi 开发工作流程

本指南总结了在 OpenClaw 中开发 Pi 集成的合理工作流程。

## 类型检查和代码检查

- 类型检查和构建：`pnpm build`
- 代码检查：`pnpm lint`
- 格式检查：`pnpm format`
- 推送前完整检查：`pnpm lint && pnpm build && pnpm test`

## 运行 Pi 测试

使用专用脚本运行 Pi 集成测试集：

```bash
scripts/pi/run-tests.sh
```

要包含执行真实提供商行为的实时测试：

```bash
scripts/pi/run-tests.sh --live
```

该脚本通过以下 glob 模式运行所有 Pi 相关的单元测试：

- `src/agents/pi-*.test.ts`
- `src/agents/pi-embedded-*.test.ts`
- `src/agents/pi-tools*.test.ts`
- `src/agents/pi-settings.test.ts`
- `src/agents/pi-tool-definition-adapter.test.ts`
- `src/agents/pi-extensions/*.test.ts`

## 手动测试

推荐流程：

- 以开发模式运行 Gateway 网关：
  - `pnpm gateway:dev`
- 直接触发智能体：
  - `pnpm openclaw agent --message "Hello" --thinking low`
- 使用 TUI 进行交互式调试：
  - `pnpm tui`

对于工具调用行为，提示执行 `read` 或 `exec` 操作，以便查看工具流式传输和负载处理。

## 完全重置

状态存储在 OpenClaw 状态目录下。默认为 `~/.openclaw`。如果设置了 `OPENCLAW_STATE_DIR`，则使用该目录。

要重置所有内容：

- `openclaw.json` 用于配置
- `credentials/` 用于认证配置文件和 token
- `agents/<agentId>/sessions/` 用于智能体会话历史
- `agents/<agentId>/sessions.json` 用于会话索引
- `sessions/` 如果存在旧版路径
- `workspace/` 如果你想要一个空白工作区

如果只想重置会话，删除该智能体的 `agents/<agentId>/sessions/` 和 `agents/<agentId>/sessions.json`。如果不想重新认证，保留 `credentials/`。

## 参考资料

- https://docs.openclaw.ai/testing
- https://docs.openclaw.ai/start/getting-started
