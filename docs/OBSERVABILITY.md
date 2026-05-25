# ClaWorks 可观测性

生产环境建议三层叠加：**Prometheus 指标**、**W3C traceparent 关联**、**OpenTelemetry 导出**（Gateway 侧）。

---

## 1. Prometheus 指标

ClaWorks runtime 暴露：

```bash
curl -s http://127.0.0.1:18800/v1/metrics
```

关键指标（节选）：

| 指标                              | 说明                                |
| --------------------------------- | ----------------------------------- |
| `claworks_playbook_runs_total`    | Playbook 执行次数（按 status 标签） |
| `claworks_events_published_total` | EventKernel 发布事件数              |

`/v1/health` 与 `/v1/metrics` 默认免 Bearer（K8s 探针友好）。

---

## 2. W3C traceparent（ClaWorks runtime）

ClaWorks 在 **EventKernel → PlaybookRun → StepLog** 贯通 W3C `traceparent`：

- REST 入站：请求头 `traceparent` 或 body 字段
- 出站事件：子 span 自动派生
- 关联字段：`PlaybookRun.traceparent`、`StepLog.traceparent`

本地验证：

```bash
pnpm test packages/claworks-runtime/src/kernel/event-trace.test.ts
pnpm test packages/claworks-runtime/src/planes/orch/trace-propagation.test.ts
```

---

## 3. OpenTelemetry / Collector（Gateway 插件）

ClaWorks **单体 runtime 不内置 OTLP SDK**；与 OpenClaw 共用 Gateway 时，启用 `diagnostics-otel` 插件将 **Gateway / Agent / 模型调用** 导出到 collector。

### 最小生产配置

参考 `contrib/examples/claworks-production.openclaw.fragment.json`：

```json
{
  "plugins": {
    "allow": ["claworks-robot", "diagnostics-otel", "diagnostics-prometheus"],
    "entries": {
      "diagnostics-otel": { "enabled": true }
    }
  }
}
```

环境变量（标准 OTLP）：

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318
export OTEL_SERVICE_NAME=claworks-gateway
export OTEL_RESOURCE_ATTRIBUTES=deployment.environment=production
```

### 与 ClaWorks traceparent 关联

| 层                         | trace 来源                             |
| -------------------------- | -------------------------------------- |
| Gateway HTTP / WebSocket   | OpenClaw diagnostic trace（OTEL span） |
| ClaWorks REST `/v1/events` | W3C traceparent → EventKernel          |
| Playbook 步骤              | 子 span traceparent                    |

**当前限制**：ClaWorks EventKernel span **尚未自动注入** `diagnostics-otel` 上下文。运维可通过日志中的 `traceId` / REST 响应中的 `traceparent` 做跨层关联；完整统一 trace 待 P2 桥接层。

验证 Gateway OTEL 烟测：

```bash
pnpm qa:otel:smoke
```

文档：[OpenClaw OpenTelemetry](https://docs.openclaw.ai/gateway/opentelemetry)（fork 内见 `docs/gateway/opentelemetry.md`）。

---

## 4. 日志

```bash
export LOG_LEVEL=debug   # runtime Playbook / EventKernel 详细日志
```

`packages/claworks-runtime/src/claworks/logger.ts` 对 token/password 脱敏。

---

## 5. 弱模型回归 CI

| 触发               | Workflow                                               |
| ------------------ | ------------------------------------------------------ |
| PR（runtime 变更） | `.github/workflows/claworks-weak-model-regression.yml` |
| 每日 03:15 UTC     | 同上                                                   |
| 手动               | `workflow_dispatch`                                    |

本地：

```bash
CLAWORKS_PACKS_DIR=../claworks-packs pnpm claworks:weak-model-regression
```

**PR merge 门禁**：在 GitHub 仓库 Settings → Branch protection 中将 `ClaWorks Weak Model Regression / weak_model_regression` 设为 required check。

---

## 6. 路线图（P2）

- [ ] EventKernel publish → diagnostics-otel span 桥接
- [ ] Playbook step 耗时 histogram 导出 OTLP
- [ ] 统一 Grafana dashboard（metrics + traces + playbook runs）
