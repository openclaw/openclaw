# ClaWorks 生产就绪指南

**更新**：2026-05-22  
**范围**：不含 Studio React 编辑器；以 `@claworks/runtime` + `claworks-robot` 为准。

---

## 1. 生产模式（fail-closed）

| 配置                    | 说明                                                                                                 |
| ----------------------- | ---------------------------------------------------------------------------------------------------- |
| `production_mode: true` | Playbook 中 llm/skill/subagent/script/call_playbook/publish_event 无 bridge 时 **抛错**，不静默 stub |
| `CLAWORKS_PRODUCTION=1` | 环境变量：未显式设置 `production_mode` 时等价于 true                                                 |
| 未知 function           | 生产模式 throw；开发模式返回 `{ status: "stub" }`                                                    |

---

## 2. 一键安全初始化

```bash
CLAWORKS_INIT_SECURE=1 pnpm claworks:init
```

写入：`api.api_key`、`api.require_api_key`、`gateway.auth.token`、`production_mode: true`、端口 **18800**。

已有配置就地升级（不覆盖 packs/peers）：再次运行上述命令即可。

---

## 3. 生产检查清单

| 项                           | 期望                                                    |
| ---------------------------- | ------------------------------------------------------- |
| `pnpm claworks:runtime:test` | 全绿                                                    |
| `pnpm claworks:smoke`        | 全绿                                                    |
| `GET /v1/doctor`             | security / production_mode 无 error                     |
| KB                           | `data.kb_provider=memory-core` + `CLAWORKS_VECTOR_KB=1` |
| DB                           | 大规模建议 `postgresql://`                              |
| Connector                    | 生产不用 `simulate: true`                               |
| A2A mesh                     | `security.require_https_a2a: true`                      |

---

## 4. Connector 生产 vs 模拟

生产：

```json
{ "connectors": { "plant": { "preset": "mqtt", "enabled": true } } }
```

烟测：

```json
{ "connectors": { "plant": { "preset": "mqtt", "simulate": true, "enabled": true } } }
```

---

## 5. REST 速率限制

默认 60 请求/分钟/subject；超限 `429` + `Retry-After`。`/v1/health` 与 `/v1/metrics` 豁免。

---

## 6. LLM 结构化输出

Playbook 步骤可设 `output_schema` + 可选 `output_voting`，使用 `StructuredOutputEngine` 保证 JSON 格式与投票一致性。

---

## 7. 发布前验收

```bash
pnpm claworks:runtime:test
pnpm test extensions/claworks-robot
pnpm claworks:smoke
pnpm claworks:gateway:e2e   # 可选
```

---

## 8. 权威文档

1. 本文
2. `IMPLEMENTATION-STATUS.md`
3. `SYSTEM-AUDIT.md`
4. `PRODUCT-PROFILE.md`
