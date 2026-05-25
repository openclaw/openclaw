# ClaWorks WIP 清单

> 最后更新：2026-05-25  
> **分支**：`local/claworks-product`

## 已合入（近期批次）

| 批次             | 提交         | 内容摘要                                                                 |
| ---------------- | ------------ | ------------------------------------------------------------------------ |
| init + 警告      | `a920931f8b` | `claworks init` CLI、`collectClaworksInitWarnings`、OT simulate 生产警告 |
| profile 原子切换 | `ee52aacdac` | `pack.load_profile_requested` → PackLoader 串行重载                      |
| 自治 + health    | `fb7f19bf76` | `autonomy.learn_opportunity`、probe 免 auth                              |
| W3C traceparent  | `d2c83ba4b6` | EventKernel → PlaybookRun → StepLog 贯通                                 |
| 弱模型 CI        | `8a026dafa0` | `claworks-weak-model-regression.yml` nightly + 门禁脚本                  |
| evolve HITL      | `aad6de9366` | 草稿 propose → sandbox import → 晋升事件链                               |
| 生产 echo 守卫   | （本批次）   | doctor 检测、`repairClaworksJsonConfig` 生产模式禁用 echo                |

## B 类 — 明确不提交

| 路径                               | 说明                                 |
| ---------------------------------- | ------------------------------------ |
| `packages/claworks-runtime/dist/*` | 构建输出（`.gitignore` 已含 `dist`） |
| `.env`                             | 本地密钥                             |
| `~/.claworks/credentials/*`        | 运行时凭证                           |

## 待办（P2 路线图）

| 项                      | 说明                                                           |
| ----------------------- | -------------------------------------------------------------- |
| Studio React 编辑器     | 静态 `/studio` 已有，全功能编辑器未做                          |
| OT 连接器实机联调       | 默认 simulate；生产需 mqtt/opcua/modbus 现场验收               |
| `@claworks/runtime` npm | 暂缓，见 `docs/design/REBRAND-TO-CLAWORKS.md`                  |
| OTEL 导出器集成         | traceparent 贯通已做；接 collector / diagnostics-otel 插件待办 |
| 弱模型 CI merge 门禁    | nightly 已有；PR 分支 block merge 待接                         |

## 当前状态

- **测试**：`pnpm test packages/claworks-runtime` → **395/395**（89 文件）
- **工作区**：本批次 doctor/oxlint/文档更新待合入
