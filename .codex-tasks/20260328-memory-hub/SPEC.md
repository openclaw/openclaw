# SPEC

- 目标：按 `docs/superpowers/plans/2026-03-28-memory-hub.md` 实现首版 memory hub。
- 边界：单机本地、三端本地真源 + 中央聚合层、文件镜像 + SQLite/FTS、canonical merge、CAS 写回保护、review queue、audit、rollback。
- 验证顺序：event schema -> revision -> merge -> index db -> writeback -> retriever -> review/rollback -> 手工 CAS/merge 验证。
- 当前工作目录：`.worktrees/memory-hub`。
