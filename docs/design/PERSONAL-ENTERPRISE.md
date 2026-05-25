# 个人企业（Personal Work）部署指南

**目标**：以本机为「生产环境」，飞书为前台，自托管 **Qwen** 为 LLM（**不使用** `plugins/qwen` 阿里云通道）。

---

## 1. 环境变量

复制并编辑：

```bash
cp contrib/examples/claworks-personal.env.example ~/.claworks/personal.env
# 编辑 CLAWORKS_QWEN_BASE_URL、模型名、KB 目录
set -a && source ~/.claworks/personal.env && set +a
```

| 变量                        | 说明                                                                            |
| --------------------------- | ------------------------------------------------------------------------------- |
| `CLAWORKS_PRODUCT_PROFILE`  | 固定 `personal_work`                                                            |
| `CLAWORKS_QWEN_BASE_URL`    | 自托管 OpenAI 兼容根 URL（含 `/v1`）                                            |
| `CLAWORKS_QWEN_CHAT_MODEL`  | 对话模型 id                                                                     |
| `CLAWORKS_QWEN_EMBED_MODEL` | 向量嵌入模型 id（KB 用）                                                        |
| `CLAWORKS_KB_WATCH_DIRS`    | filesystem-kb 监视目录（OpenClaw KB 见 `docs/claworks/oriosearch-kb-setup.md`） |
| `CLAWORKS_OPENCLAW_KB_ROOT` | iMac 挂载的 `knowledge_base` 根路径                                             |

---

## 2. 一键修复配置

```bash
cd /path/to/claworks
set -a && source ~/.claworks/personal.env && set +a
CLAWORKS_VECTOR_KB=1 pnpm claworks:repair
pnpm claworks:start
```

`repair` 会：

- 设置 `plugins.allow`（**无** `qwen` 插件）
- 写入 `models.providers.qwen-local` + `agents.defaults.model.primary`
- 启用 `memory-core` + `memory-lancedb`，嵌入指向自托管 URL
- 安装 Pack：`base`、`enterprise-general`、`enterprise-commercial`、`personal-enterprise`
- 启用 `filesystem-kb` connector（监视文档目录 → `kb.folder_sync` → 自动入库）

---

## 3. LLM 架构说明

| 方式                                             | 说明                                    |
| ------------------------------------------------ | --------------------------------------- |
| ✅ `openai` 插件 + `models.providers.qwen-local` | 指向你的推理服务 `/v1/chat/completions` |
| ❌ `plugins/qwen`                                | 阿里云 DashScope，需 Ali API Key        |

`memory-lancedb` 的 `embedding` 同样指向 `CLAWORKS_QWEN_BASE_URL`（OpenAI 兼容 embeddings API）。

---

## 4. 飞书工作流

| 你说的话（示例） | Pack 能力                   |
| ---------------- | --------------------------- |
| 我有哪些待办     | `query_task_status_from_im` |
| 帮我记个任务     | `task.create` 意图          |
| 查知识库 / 制度  | `kb_query_from_im`          |
| 会议纪要…        | `meeting_minutes_ingest`    |

需已配置飞书插件并登录；`im_bridge.auto_on_message_received` 默认开启。

---

## 5. 验证

```bash
# 修复配置 + 构建 runtime + 重启网关
set -a && source ~/.claworks/personal.env && set +a
pnpm claworks:repair:personal
node claworks.mjs gateway restart

# 一键验收（health / kb / playbook / kb-smoke）
pnpm claworks:personal:verify
```

或手动：

```bash
curl -s http://127.0.0.1:18800/v1/kb/status | jq .
curl -s http://127.0.0.1:18800/v1/health | jq .kb_provider
pnpm claworks:kb-smoke
```

---

## 6. 相关文件

- `contrib/examples/robot-personal.md` — 复制为 `~/.claworks/robot.md` 可选
- `claworks-packs/personal-enterprise/` — KB 目录同步 Playbook
- `connectors/filesystem-kb/` — 文件夹监视 Connector
- `docs/claworks/oriosearch-kb-setup.md` — OpenClaw 知识库 SMB 挂载、批量入库、本体导入
