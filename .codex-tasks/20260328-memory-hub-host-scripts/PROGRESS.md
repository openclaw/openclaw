任务: 统一三端宿主脚本管理
形态: single-full
进度: 4/4
当前: 收尾完成
验证: `python3 scripts/deploy_memory_hub_host_hooks.py --target all` 后，`cmp -s` 已确认三端宿主脚本与 worktree 真源一致
文件: .codex-tasks/20260328-memory-hub-host-scripts/
下一步: 如需继续，可提交这轮宿主脚本管理收敛改动，或进一步把 Claude/OpenClaw/Codex 的自动触发配置也纳入统一部署策略

## 已完成收敛
- worktree 内新增统一宿主脚本目录 `scripts/host_hooks/`
- Claude / OpenClaw / Codex 三端宿主脚本已回收到仓库真源
- 新增最小部署脚本 `scripts/deploy_memory_hub_host_hooks.py`
- 已验证部署后宿主脚本与 worktree 真源一致
