---
title: "Pi 开发工作流程"
summary: "Pi 集成的开发者工作流程：构建、测试和实时验证"
read_when:
  - 处理 Pi 集成代码或测试
  - 运行 Pi 特定的 lint、类型检查和实时测试流程
---

# Pi 开发工作流程

本指南总结了在 OpenClaw 中处理 Pi 集成的合理工作流程。

## 类型检查和代码检查

- 默认本地检查：`pnpm check`
- 构建检查：当更改可能影响构建输出、打包或懒加载/模块边界时，使用 `pnpm build`
- Pi 相关更改的完整落地检查：`pnpm check && pnpm test`

## 运行 Pi 测试

直接使用 Vitest 运行 Pi 相关的测试集：

```bash
pnpm test \
  "src/agents/pi-*.test.ts" \
  "src/agents/pi-embedded-*.test.ts" \
  "src/agents/pi-tools*.test.ts" \
  "src/agents/pi-settings.test.ts" \
  "src/agents/pi-tool-definition-adapter*.test.ts" \
  "src/agents/pi-hooks/**/*.test.ts"
```

要包含实时提供者测试：

```bash
OPENCLAW_LIVE_TEST=1 pnpm test src/agents/pi-embedded-runner-extraparams.live.test.ts
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

- 以开发模式运行网关：
  - `pnpm gateway:dev`
- 直接触发代理：
  - `pnpm openclaw agent --message "Hello" --thinking low`
- 使用 TUI 进行交互式调试：
  - `pnpm tui`

对于工具调用行为，提示 `read` 或 `exec` 操作，以便查看工具流和有效载荷处理。

## 完全重置

状态存储在 OpenClaw 状态目录下。默认是 `~/.openclaw`。如果设置了 `OPENCLAW_STATE_DIR`，则使用该目录。

要重置所有内容：

- `openclaw.json` 用于配置
- `agents/<agentId>/agent/auth-profiles.json` 用于模型认证配置文件（API 密钥 + OAuth）
- `credentials/` 用于仍存储在认证配置文件存储之外的提供者/通道状态
- `agents/<agentId>/sessions/` 用于代理会话历史
- `agents/<agentId>/sessions/sessions.json` 用于会话索引
- 如果存在旧路径，则为 `sessions/`
- 如果你想要空白工作区，则为 `workspace/`

如果你只想重置会话，删除该代理的 `agents/<agentId>/sessions/`。如果你想保留认证，保留 `agents/<agentId>/agent/auth-profiles.json` 和 `credentials/` 下的任何提供者状态。

## 参考

- [测试](/help/testing)
- [入门](/start/getting-started)