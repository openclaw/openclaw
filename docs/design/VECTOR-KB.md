# ClaWorks 向量知识库（memory-core + LanceDB）

ClaWorks **不在 runtime 内重复实现向量索引**；语义检索走 OpenClaw 插件栈：

| 层   | 插件             | 职责                                                        |
| ---- | ---------------- | ----------------------------------------------------------- |
| 桥接 | `claworks-robot` | `kb_provider: memory-core` 时 `createMemoryKnowledgeBase()` |
| 检索 | `memory-core`    | `manager.search()` / `manager.sync()`                       |
| 存储 | `memory-lancedb` | `plugins.slots.memory` 向量后端                             |

## 一键启用

```bash
# 产品白名单已含 memory-core + memory-lancedb
CLAWORKS_VECTOR_KB=1 pnpm claworks:repair
# 或
pnpm claworks:start
```

`repairClaworksJsonConfig` / `repairVectorKnowledgeBase` 会写入：

- `plugins.allow`: `memory-core`, `memory-lancedb`
- `plugins.slots.memory`: `memory-lancedb`
- `plugins.entries.memory-core.config.provider`: `lancedb`
- `plugins.entries.claworks-robot.config.data.kb_provider`: `memory-core`
- `data.kb_path`: `~/.claworks/kb/lancedb`
- `data.kb_embed_model`: `text-embedding-3-small`（或 `model_router.embed`）

## 运维

| 入口                              | 说明                                                       |
| --------------------------------- | ---------------------------------------------------------- |
| `GET /v1/kb/status`               | 实时桥接状态（provider、vector、embed 模型、kb-drop 路径） |
| `GET /v1/kb/search?q=&namespace=` | REST 语义/子串检索                                         |
| `POST /v1/kb/ingest`              | 单条入库 + memory sync                                     |
| `POST /v1/kb/ingest/folder`       | 批量文件夹入库，结束后 `kb.flush()`                        |
| `cw_kb_status`                    | 与 `/v1/kb/status` 等价                                    |
| `cw_kb_ingest`                    | 写入 `~/.claworks/kb-drop/` 并触发 memory sync             |
| `cw_kb_search`                    | 经 memory-core 语义检索（可选 `namespace`）                |
| `cw_kb_ingest_folder`             | 批量文件夹入库                                             |
| `POST /v1/kb/flush`               | 强制向量索引同步                                           |
| `cw_kb_flush`                     | 与 flush REST 等价                                         |

实机烟测（网关已启动）：

```bash
CLAWORKS_VECTOR_KB=1 pnpm claworks:repair
pnpm claworks:start   # 另一终端
node scripts/claworks-kb-smoke.mjs
```

`repairVectorKnowledgeBase` 会同步 `plugins.entries.memory-lancedb.embedding.model` 与 `data.kb_embed_model`。

`claworks doctor` / `GET /v1/health` 会报告 `kb` / `kb_provider`；完整桥接细节用 `/v1/kb/status`。

## 与 stub / 文件 KB 的关系

| `kb_provider`              | 行为                                 |
| -------------------------- | ------------------------------------ |
| 未设置 / `stub`            | runtime 内存子串匹配（开发/演示）    |
| `memory-core`              | 插件注入 `KnowledgeBase`，走 LanceDB |
| `kb_path` + 非 memory-core | `knowledge-base-file.ts` 子串文件 KB |

详见 `docs/design/CONFIG-SCHEMA.md` 的 `data.*` 字段。
