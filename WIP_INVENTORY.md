# ClaWorks WIP 清单

> 最后更新：2026-05-24  
> **当前状态：工作区干净**（`git status` 无未提交项）。原 C 类批次已在 `a920931f8b`–`9e4ce46b05` 合入。

## 已合入（原 C 类，2026-05-24）

| 批次         | 提交         | 内容摘要                                                                      |
| ------------ | ------------ | ----------------------------------------------------------------------------- |
| init + 警告  | `a920931f8b` | `claworks init` CLI 注册、`collectClaworksInitWarnings`、OT simulate 生产警告 |
| 产品面 P0/P1 | `b73fc05263` | runtime 内核、doctor 契约、产品 CLI 文案、storage 适配器移除                  |
| 网关/向导    | `c8e864a7f2` | 默认端口 18800、wizard 产品合并                                               |
| 向导收尾     | `1c46e9f059` | onboard 后 ClaWorks 下一步提示、init 警告导出                                 |
| 发布文档     | `c6f2c224f2` | `docs/RELEASE-CHECKLIST.md`、gateway e2e 签收说明                             |
| 测试对齐     | `9e4ce46b05` | product-surface 文案测试                                                      |

## B 类 — 明确不提交

| 路径                               | 说明                                                                 |
| ---------------------------------- | -------------------------------------------------------------------- |
| `packages/claworks-runtime/dist/*` | 构建输出（本地 build 产物；CI/发布前 `pnpm claworks:runtime:build`） |
| `.env`                             | 本地密钥                                                             |
| `~/.claworks/credentials/*`        | 运行时凭证                                                           |

## 待办（非 WIP，P2 路线图）

| 项                                     | 说明                                             |
| -------------------------------------- | ------------------------------------------------ |
| `pack.load_profile_requested` 原子切换 | Playbook 已发事件，PackLoader 侧待完善           |
| 分布式 OTEL trace                      | EventKernel → PlaybookRun → StepLog              |
| 弱模型回归 CI nightly                  | `weak_model_regression_suite` 门禁               |
| Studio React 编辑器                    | 静态 `/studio` 已有，全功能编辑器未做            |
| OT 连接器实机联调                      | 默认 simulate；生产需 mqtt/opcua/modbus 现场验收 |
| `@claworks/runtime` npm 公开发布       | 暂缓，见 `docs/design/REBRAND-TO-CLAWORKS.md`    |
