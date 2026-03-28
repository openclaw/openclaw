# OpenClaw memory-hub 宿主配置最小托管说明

## 当前状态
- OpenClaw 目前未接入真实自动触发配置。
- 已存在的最小宿主入口脚本为：
  - `scripts/openclaw_memory_hub_hook.py`
- 该脚本的 worktree 真源为：
  - `scripts/host_hooks/openclaw_memory_hub_hook.py`

## 当前托管策略
- **脚本真源**：由 worktree 管理
- **宿主运行入口**：部署到 `OpenClaw/state/workspace-daily/scripts/openclaw_memory_hub_hook.py`
- **自动触发配置**：暂未接入；保持手工 bridge 方式

## 后续建议
- 等决定 OpenClaw 真实事件源后，再把自动触发配置纳入统一部署
- 当前阶段不扩功能，只保留最小 bridge
