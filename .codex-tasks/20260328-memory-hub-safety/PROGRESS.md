任务: 统一三端 memory-hub 的 review / rollback / backup 真实闭环
形态: single-full
进度: 4/4
当前: 收尾完成
验证: `python3 -m unittest tests.memory_hub.test_claude_hook_bridge tests.memory_hub.test_openclaw_hook_bridge tests.memory_hub.test_codex_hook_bridge tests.memory_hub.test_event_schema tests.memory_hub.test_revision tests.memory_hub.test_merge tests.memory_hub.test_index_db tests.memory_hub.test_writeback tests.memory_hub.test_retriever tests.memory_hub.test_review_and_rollback -v` -> 31 tests OK
文件: .codex-tasks/20260328-memory-hub-safety/
下一步: 如需继续，可提交这轮 safety 收敛改动，或再做一次三端真实宿主级 backup / rollback 手工验证

## 已完成收敛
- auto_write 会在目标 memory file 和 index file 上生成 backup
- enqueue_review 不再只返回动作，已真实写入 review queue
- rollback 可基于 backup 恢复目标文件
- 全量测试通过，且未破坏 Claude / OpenClaw / Codex 三端最小 bridge
