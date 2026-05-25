# ClaWorks WIP 清单

> 最后更新：2026-05-25  
> **分支**：`local/claworks-product`（ClaWorks 相关改动与 OpenClaw 同步改动可能共存于工作区）

## 已合入（原 C 类 + 近期 P1）

| 批次             | 提交         | 内容摘要                                                                       |
| ---------------- | ------------ | ------------------------------------------------------------------------------ |
| init + 警告      | `a920931f8b` | `claworks init` CLI 注册、`collectClaworksInitWarnings`、OT simulate 生产警告  |
| 产品面 P0/P1     | `b73fc05263` | runtime 内核、doctor 契约、产品 CLI 文案、storage 适配器移除                   |
| 网关/向导        | `c8e864a7f2` | 默认端口 18800、wizard 产品合并                                                |
| 向导收尾         | `1c46e9f059` | onboard 后 ClaWorks 下一步提示、init 警告导出                                  |
| 发布文档         | `c6f2c224f2` | `docs/RELEASE-CHECKLIST.md`、gateway e2e 签收说明                              |
| 测试对齐         | `9e4ce46b05` | product-surface 文案测试                                                       |
| profile 原子切换 | `ee52aacdac` | `pack.load_profile_requested` → PackLoader，`profileSwitchChain` 串行重载      |
| 自治 + health    | `fb7f19bf76` | `autonomy.learn_opportunity`、probe 免 auth、`registerPackProfileEventHandler` |
| 签收快照         | `9715ec8f7e` | 368 测试 + gateway e2e 文档                                                    |

## B 类 — 明确不提交

| 路径                               | 说明                                                                             |
| ---------------------------------- | -------------------------------------------------------------------------------- |
| `packages/claworks-runtime/dist/*` | 构建输出（根 `.gitignore` 已含 `dist`；CI/发布前 `pnpm claworks:runtime:build`） |
| `.env`                             | 本地密钥                                                                         |
| `~/.claworks/credentials/*`        | 运行时凭证                                                                       |

## 待办（P2 路线图）

| 项                      | 说明                                                                   |
| ----------------------- | ---------------------------------------------------------------------- |
| 弱模型回归 CI nightly   | `weak_model_regression_suite` Playbook 已有，缺 CI workflow + 门禁脚本 |
| Studio React 编辑器     | 静态 `/studio` 已有，全功能编辑器未做                                  |
| OT 连接器实机联调       | 默认 simulate；生产需 mqtt/opcua/modbus 现场验收                       |
| `@claworks/runtime` npm | 暂缓，见 `docs/design/REBRAND-TO-CLAWORKS.md`                          |
| OTEL 导出器集成         | 最小 traceparent 贯通已做；接 collector / diagnostics-otel 插件待办    |

## 进行中（本批次，待提交）

- W3C `traceparent` / `traceId`：EventKernel → PlaybookRun → StepLog
- `evolve-engine.test.ts`：自动学习 + CBR 注入回归测试
