任务: 实现 memory hub：worktree + CSV 事实源，持续推进到验证完成
形态: single-full
进度: 4/4
当前: 收尾完成
验证: 2026-03-28 fresh run 通过
文件: .codex-tasks/20260328-memory-hub/
下一步: 如需继续，可进入分支整理、代码审查或集成流程

## Fresh 验证证据

- 全量单测：`python3 -m unittest tests.memory_hub.test_event_schema tests.memory_hub.test_revision tests.memory_hub.test_merge tests.memory_hub.test_index_db tests.memory_hub.test_writeback tests.memory_hub.test_retriever tests.memory_hub.test_review_and_rollback -v`
  结果：16 tests, OK
- hub init CLI：`python3 scripts/memory_hub_init.py --hub-root /tmp/memory-hub-init-check`
  结果：生成 `/tmp/memory-hub-init-check/hub.sqlite3`，并包含 `memory_records`、`memory_records_fts`、`review_queue`、`audit_log`、`writeback_jobs`、`source_bindings` 等核心表
- direct CLI ingest：`python3 scripts/memory_hub_ingest_event.py --hub-root /tmp/memory-hub-cli-check/hub --event-json /tmp/memory-hub-cli-check/event.json`
  结果：返回 `writeback.action=auto_write`；正确导出 `host_roots["claude-code"]`；写入 `/tmp/memory-hub-cli-check/claude_memory/short_reply.md` 与 `/tmp/memory-hub-cli-check/claude_memory/MEMORY.md`

## 说明

- 当前 worktree 上 direct CLI 空 `host_roots` 场景在 fresh 手工验证中未再出现 `KeyError('claude-code')`。
- 本次 fresh 验证显示测试总数为 16，而不是之前口头同步中的 15。
- 剩余风险主要在跨 host adapter 的真实宿主环境覆盖仍以单测和单次手工验证为主。
