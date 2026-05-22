# 本机 `/Users/power/Projects` 工业 AI 相关资源清单

**用途**：与 **`industrial-pipeline-station-ai-landing.zh.md`** 对照，明确**你已具备的仓库**与**建议接线顺序**。路径以本机为准；若迁移机器请全文替换根目录。

---

## 一、核心资产（优先接线）

| 目录                                         | 角色                                                                                                                   | 与落地文档的对应                                 |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| **`openclaw`**                               | OpenClaw 源码与 CLI；Gateway、插件、`memory-wiki`、QMD、MCP                                                            | 人机编排层                                       |
| **`openclaw-enterprise-design`**             | 场站孪生设计包：Fuseki/SPARQL、Milvus、MinIO、Docker 编排、`samples/twin3d` 阀预览、`ENTERPRISE_TWIN_SYSTEM_DESIGN.md` | **图/本体 + RAG + 3D** 的本机栈蓝图              |
| **`predictive-maintenance-knowledge-graph`** | Neo4j + 语义层 + v2.1 向量；半导体/泵维护本体文档                                                                      | **属性图 / 仿真友好** 的参考实现或数据形态       |
| **`palantir`**                               | Rust：CSV → 自动发现实体/关系 → `ontology_graph.json`                                                                  | **表格式主数据** 抽样 → 轻量图草图（人审后并网） |
| **`palantir-ontology-strategy`**             | ontology 战略与叙事（书籍向）                                                                                          | **方法论**；非运行时                             |

---

## 二、OpenClaw 生态与扩展（按需）

| 目录                                            | 说明                                                                         |
| ----------------------------------------------- | ---------------------------------------------------------------------------- |
| **`openclaw-admin`**                            | Vue 管理台；与 enterprise-design 解耦                                        |
| **`ai-robot-platform`**                         | AnythingLLM + OpenClaw + `case-bridge`；多机器人案例信封                     |
| **`awesome-openclaw*`、`clawhub`、`skills` 等** | 社区技能与用例；**工业线**建议只用 **经评审** 的少数 Skill，避免全家桶进生产 |

---

## 三、建议的「系统搭建」顺序（结合现有仓库）

1. **OpenClaw 侧（已部分完成）**
   - `memory-core` + QMD + `memory-wiki` bridge + `~/.openclaw/knowledge`
   - MCP：`gen-mcp-fetch`（收窄白名单）
   - 挂载工业 Skills：见 **`contrib/industrial-oilgas-skills/README.md`**

2. **企业设计栈（本机 Docker）**
   - `cd /Users/power/Projects/openclaw-enterprise-design/deployment`
   - `docker compose -f local-mac-compose.example.yaml up -d`
   - 按 **`guides/ONTOLOGY_KG_3D_VALVE.md`** 走 Turtle / Fuseki / SPARQL

3. **3D 预览（无 UE 也可 MVP）**
   - `samples/twin3d`：`python3 -m http.server 8765` → `preview.html`
   - `equipment_id` 与 Fuseki 中 `twin:tag` 对齐（见 sample README）

4. **图/属性图第二跑道（可选）**
   - `predictive-maintenance-knowledge-graph`：导入策略或仅借鉴 schema；**Neo4j 与 Fuseki 二选一时以场站规范为准**，避免双源互飙

5. **表数据发现**
   - 台账/工单 CSV → `palantir` crate 出 JSON → **人审** → 写入 Fuseki 或 Neo4j

6. **仿真**
   - 本清单中**暂无**独立仿真服务目录；在 `Projects` 下新增专用仓或对接现网 API 后，按落地文档 **阶段 C** 加 MCP

---

## 四、一键引用 Skills（配置片段）

合并到 **`openclaw.json`** 的示例（路径随你机器调整）：

```json5
{
  skills: {
    load: {
      extraDirs: ["~/Projects/openclaw/contrib/industrial-oilgas-skills"],
    },
  },
}
```

场站智能体 workspace 的 **`skills`** 允许列表可按需收窄，见 **`docs/tools/skills.md`**。

---

## 五、维护

新增 `Projects` 子项目时，在本表**追加一行**并注明「运行时 / 文档 / 仅参考」，避免后续接线遗漏。
