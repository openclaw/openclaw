# Codex memory-hub 宿主配置最小托管说明

## 当前状态
- Codex 当前未接入自动 hook 或自动事件配置。
- 已存在的最小宿主入口脚本为：
  - `~/.codex/codex_memory_hub_hook.py`
- 该脚本的 worktree 真源为：
  - `scripts/host_hooks/codex_memory_hub_hook.py`

## 当前托管策略
- **脚本真源**：由 worktree 管理
- **宿主运行入口**：部署到 `~/.codex/codex_memory_hub_hook.py`
- **自动触发配置**：暂未接入；保持手工 bridge 方式

## 后续建议
- 等确定 Codex 可接受的自动触发/集成方式后，再把配置纳入统一部署
- 当前阶段不扩功能，只保留最小 bridge
