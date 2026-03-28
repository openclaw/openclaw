任务: 统一三端宿主脚本管理
形态: single-full
目标: 将 Claude Code、OpenClaw、Codex 的 memory-hub 宿主入口脚本统一收敛到 feature worktree 中管理，并通过可验证的部署方式同步到宿主实际路径，避免长期依赖散落在 ~/.claude、~/.codex、OpenClaw 根目录的手工脚本。
范围:
- 只处理宿主入口脚本管理与部署
- 不新增新的 memory-hub 功能
- 不改三端真源 memory 内容结构
成功标准:
1. 三端宿主脚本在 worktree 中有统一真源文件
2. 宿主实际脚本可从统一真源同步/部署
3. 至少一次部署动作有可验证结果
4. 不破坏现有三端最小链路
