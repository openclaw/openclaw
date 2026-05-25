# OrioSearch + OpenClaw 知识库接入 ClaWorks

本指南说明如何将 **iMac 上 OpenClaw 整理后的知识库**（`knowledge_base/`）接入 ClaWorks：SMB 挂载、filesystem-kb 监视、`content/` 批量入库、本体 JSON 导入，以及投标/报价检索 Playbook。

---

## 1. 知识库布局（OpenClaw 侧）

iMac 根路径：

```text
/Users/m/.openclaw/workspace/knowledge_base/
├── content/                    # Markdown 文档（7 类）
│   ├── product_manual/         # → ClaWorks namespace: products
│   ├── tender_document/        # → tender
│   ├── other/                  # → company（资质、证书）
│   ├── software_copyright/     # → copyright
│   ├── patent_design/          # → patents
│   ├── tender_platform/        # → tender_platform
│   └── case_study/             # → cases（可为空）
├── metadata/file_index.json    # 可选：源路径/标题索引（导入脚本会读取并记录）
├── ontology/
│   ├── enterprise_ontology.json
│   ├── relationship_ontology.json
│   └── industry_ontology.json
└── USE_GUIDE.md, process_files.py, …
```

**SMB**（Finder → 前往 → 连接服务器）：

```text
smb://m的iMac._smb._tcp.local/Macintosh HD/
```

挂载后本机典型路径（卷名因 macOS 而异，以 `ls /Volumes` 为准）：

```text
/Volumes/Macintosh HD/Users/m/.openclaw/workspace/knowledge_base
```

若卷名带后缀，例如 `Macintosh HD-1`：

```text
/Volumes/Macintosh HD-1/Users/m/.openclaw/workspace/knowledge_base
```

---

## 2. 环境变量

复制并编辑：

```bash
cp contrib/examples/claworks-personal.env.example ~/.claworks/personal.env
set -a && source ~/.claworks/personal.env && set +a
```

| 变量                            | 说明                                                             |
| ------------------------------- | ---------------------------------------------------------------- |
| `CLAWORKS_OPENCLAW_KB_ROOT`     | 挂载后的 `knowledge_base` 绝对路径                               |
| `CLAWORKS_KB_WATCH_DIRS`        | filesystem-kb 监视目录（建议 `…/content`）                       |
| `CLAWORKS_KB_WATCH_INTERVAL_MS` | 监视间隔，默认 `300000`（5 分钟）                                |
| `CLAWORKS_KB_NAMESPACE`         | 自动监视入库的默认命名空间（`work`）；**分类命名空间**见批量脚本 |
| `CLAWORKS_ORIOSEARCH_URL`       | 自托管 OrioSearch（Tavily 兼容），默认 `http://127.0.0.1:8000`   |
| `CLAWORKS_VECTOR_KB`            | 设为 `1` 启用向量 KB                                             |
| `CLAWORKS_QWEN_BASE_URL`        | 自托管嵌入/对话 API（OpenAI 兼容 `/v1`）                         |

应用配置：

```bash
CLAWORKS_VECTOR_KB=1 pnpm claworks:repair:personal
node claworks.mjs gateway restart
```

`repair:personal` 会启用 `filesystem-kb` connector，并将 `CLAWORKS_KB_WATCH_DIRS` 写入 connector 环境。

---

## 3. 批量入库（7 类 Markdown → 命名空间）

需 **ClaWorks Gateway 已运行**（默认 `http://127.0.0.1:18800`）。

```bash
# 全部 7 类 + ontology（首次推荐）
node scripts/claworks-kb-import-openclaw-workspace.mjs --all

# 仅某一类
node scripts/claworks-kb-ingest-folder.mjs \
  --folder "$CLAWORKS_OPENCLAW_KB_ROOT/content/tender_document" \
  --namespace tender

# 仅本体 JSON
node scripts/claworks-kb-import-openclaw-workspace.mjs --ontology-only

# 预览计划
node scripts/claworks-kb-import-openclaw-workspace.mjs --all --dry-run
```

底层 API：`POST /v1/kb/ingest/folder`（Markdown/txt/json/yaml/csv），结束后 `POST /v1/kb/flush`。

**file_index.json**：导入脚本会加载 `metadata/file_index.json` 并在日志中报告条目数；当前 ingest 仍按文件路径入库，`source_prefix` 为 `openclaw-kb/<category>/…`。若需按 index 标题/路径重写 `source`，可在后续版本扩展。

---

## 4. 本体（ontology）导入

不新增 REST 端点。脚本读取 `ontology/*.json`，通过现有能力：

1. **`ontology.bootstrap_from_openapi`** — 将 JSON 中的类型定义转为 OpenAPI `components.schemas` 并注册 ObjectType
2. **`cw_import_objects`** — 若 JSON 含 `entities` / `instances` / `objects` 数组，批量写入 ObjectStore

调用路径：MCP `POST /v1/mcp/tools/call`（脚本内封装）。

`relationship_ontology.json` 中的关系类型会尽量映射为 ObjectType 字段；ClaWorks 当前 OntologyEngine 以 ObjectType 为主，LinkType 图编辑在 Studio 路线图内，关系 JSON 主要服务类型注册与实例导入。

---

## 5. 检索与 Playbook（投标 / 报价）

| 场景           | namespace  | 示例 REST 搜索                                            |
| -------------- | ---------- | --------------------------------------------------------- |
| 产品手册、规格 | `products` | `GET /v1/kb/search?q=泵型号&namespace=products&limit=5`   |
| 投标文件、招标 | `tender`   | `GET /v1/kb/search?q=技术偏差表&namespace=tender&limit=5` |
| 资质证书       | `company`  | `GET /v1/kb/search?q=ISO9001&namespace=company&limit=5`   |

飞书 / IM：Pack `enterprise-commercial` + `personal-enterprise` 提供报价、投标与 KB 批量入库 Playbook；IM 意图 `查知识库` → `kb_query_from_im`。

手动触发 Playbook：

```bash
curl -s -X POST http://127.0.0.1:18800/v1/playbooks/kb_query_from_im/trigger \
  -H "Authorization: Bearer $CLAWORKS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"text":"查投标技术规范里关于质保期的要求","namespace":"tender"}'
```

---

## 6. OrioSearch（联网搜索，与 KB 互补）

OrioSearch 为 **Tavily 兼容** HTTP API（`/search`、`/extract`），由 `tavily` 插件 + `CLAWORKS_ORIOSEARCH_URL` 接入，**不是** KB 向量检索。

```bash
# 可选：Docker 启动 Orio（见 docs/design/legacy-from-openclaw/contrib/scripts/oriosearch-docker-up.sh）
export CLAWORKS_ORIOSEARCH_URL=http://127.0.0.1:8000
pnpm claworks:repair:personal
```

KB（本地 Markdown）+ Orio（联网）+ 飞书 IM 三者独立配置；`memory_search` 与 `web_search` 是不同工具面。

---

## 7. OpenClaw MCP 桥接 ClaWorks

在 OpenClaw Gateway（端口 **18789**）安装 `@claworks/openclaw-extension`，配置 `plugins.entries.claworks` 指向 ClaWorks **18800**：

```json
{
  "plugins": {
    "entries": {
      "claworks": {
        "enabled": true,
        "config": {
          "baseUrl": "http://127.0.0.1:18800",
          "apiKey": "<CLAWORKS_API_KEY>"
        }
      }
    }
  }
}
```

OpenClaw 侧可通过 MCP 工具调用 `cw_kb_search`、`cw_kb_ingest_folder`、`cw_invoke_capability` 等，与本文脚本使用同一 Gateway。

---

## 8. 验收

```bash
pnpm claworks:kb-smoke
pnpm claworks:personal:verify

# 分类检索抽查
curl -s "http://127.0.0.1:18800/v1/kb/search?q=产品&namespace=products&limit=3" | jq .
curl -s "http://127.0.0.1:18800/v1/kb/status" | jq .
```

---

## 相关文件

- `contrib/examples/claworks-personal.env.example` — 环境变量模板
- `scripts/claworks-kb-import-openclaw-workspace.mjs` — 七类 + 本体导入
- `scripts/claworks-kb-ingest-folder.mjs` — 单目录 REST 入库
- `connectors/filesystem-kb/` — 目录监视 → `kb.folder_sync`
- `docs/design/PERSONAL-ENTERPRISE.md` — personal_work 配置总览
