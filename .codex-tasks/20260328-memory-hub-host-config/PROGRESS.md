任务: 统一三端宿主配置部署策略
形态: single-full
进度: 4/4
当前: 收尾完成
验证: `python3 scripts/deploy_memory_hub_host_config.py --print-only` 已验证 Claude 配置合并结果保留 `PreToolUse`，并包含 `UserPromptSubmit` 与 `Stop`
文件: .codex-tasks/20260328-memory-hub-host-config/
下一步: 如需继续，可提交这轮宿主配置托管改动，或进一步把 OpenClaw/Codex 的自动触发配置也纳入统一部署

## 已完成收敛
- worktree 内新增统一宿主配置目录 `config/host/`
- Claude hooks 配置已抽成 worktree 真源：`config/host/claude-settings.memory-hub.json`
- OpenClaw/Codex 的当前最小配置托管方式已落成说明文档
- 新增配置部署脚本 `scripts/deploy_memory_hub_host_config.py`
