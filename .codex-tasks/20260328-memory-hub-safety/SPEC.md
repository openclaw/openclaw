任务: 统一三端 memory-hub 的 review / rollback / backup 真实闭环
形态: single-full
目标: 在不继续扩新宿主事件的前提下，把 Claude Code、OpenClaw、Codex 三端共用的 writeback 安全闭环补齐：自动生成 backup、非 auto_write 真实进入 review queue、rollback 可基于真实 backup 工作。
范围:
- worktree: /Users/mianfeishitou/OpenClaw/state/workspace-daily/.worktrees/memory-hub
- 只改 memory-hub 核心与相关测试
- 不新增新的宿主自动触发点
成功标准:
1. 自动写回前会生成可追溯 backup
2. enqueue_review 不再只是返回动作，真实写入 review queue
3. rollback 能基于生成出来的 backup 恢复目标文件
4. 相关单测和手工验证通过
