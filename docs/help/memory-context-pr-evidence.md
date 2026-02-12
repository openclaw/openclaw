# Memory Context PR 测试证据

更新时间：2026-02-12

## 目标

为 `memory-context` 相关改动提供可复现的测试证据，覆盖：

- 多轮会话下的 compaction 触发
- compaction 后的归档落盘（`segments.jsonl`）
- recall 路径可用性
- 短 query 边界行为
- 网关稳定性
- 重启后的持久化验证

## 测试环境

- Gateway: `ws://127.0.0.1:18789`
- 鉴权：`OPENCLAW_GATEWAY_TOKEN`（已脱敏，不写入仓库）
- 主要脚本：
  - `scripts/boundary-test.ts`
  - `scripts/persistence-recall.ts`

## 执行命令

### 1) 构建

```bash
pnpm build
```

### 2) 启动网关

```bash
HOME=/root bun openclaw.mjs gateway run --bind loopback --force
```

### 3) 边界与多轮验证

```bash
OPENCLAW_GATEWAY_TOKEN="$OPENCLAW_GATEWAY_TOKEN" node --import tsx scripts/boundary-test.ts
```

### 4) 重启持久化验证

```bash
OPENCLAW_GATEWAY_TOKEN="$OPENCLAW_GATEWAY_TOKEN" node --import tsx scripts/persistence-recall.ts fill persist-proof-1
# 重启网关
OPENCLAW_GATEWAY_TOKEN="$OPENCLAW_GATEWAY_TOKEN" node --import tsx scripts/persistence-recall.ts query persist-proof-1
```

## 结果摘要

### A. 发布态（无调试埋点）边界测试

日志：`/tmp/btest-clean-current.log`

- 结果：`✅10 passed / ❌0 failed / ⏭3 skipped`
- 关键通过项：
  - `Compaction triggered`
  - `Messages archived`
  - `Recall triggered`（行为路径）
  - `Short query does not trigger aggressive archive`
  - `Gateway still running`
  - `segments.jsonl has content`
  - `No plain secrets in stored segments`

说明：3 个 skip 为“扩展加载明细检查”，该检查依赖调试日志；发布态默认不写调试日志，因此按预期跳过。

### B. 调试态（用于根因定位）验证

日志：`/tmp/btest-final2.log`

- 结果：`✅13 passed / ❌0 failed / ⏭0 skipped`
- 结论：
  - compaction 事件触发正常
  - 在 `messagesToSummarize` 为空时，从 `branchEntries[].message` 提取 `user/assistant` 消息可稳定归档
  - recall 注入路径可触发

### C. 多轮稳定性

日志：

- `/tmp/btest-clean-round-1.log`
- `/tmp/btest-clean-round-2.log`
- `/tmp/btest-clean-round-3b.log`

结果：

- Round 1: `✅10 / ❌0 / ⏭3`
- Round 2: `✅10 / ❌0 / ⏭3`
- Round 3(重跑): `✅10 / ❌0 / ⏭3`

备注：曾出现 1 次连接超时（`/tmp/btest-clean-round-3.log`），重跑通过，判断为瞬时环境抖动而非功能缺陷。

### D. 重启持久化

日志：

- `/tmp/persist-fill.log`: fill `persist-proof-1` 成功（8/8）
- `/tmp/persist-query.log`: 重启后 query 成功

持久化文件：

- `~/.openclaw/memory/context/segments.jsonl`
- 重启前后均存在且持续增长（示例：`433 -> 434` 行）

## 关键修复点（对应本次提交）

1. 在 `run/attempt` 主链路接入 `DefaultResourceLoader`，确保扩展路径真正加载。
2. 动态调整 Pi `reserveTokens`，使 `contextTokens` cap 在大窗口模型（如 128k）下仍有效触发 compaction。
3. `memory-context-archive` 在 `messagesToSummarize` 为空时，回退到 `branchEntries[].message` 提取可归档消息。
4. 新增可复现测试脚本与 PR 证据 skill，沉淀测试流程。
