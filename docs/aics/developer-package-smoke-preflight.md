---
summary: "Preflight checklist before the first human developer-package smoke"
title: "AICS-293 Developer Package Smoke Preflight"
---

# AICS-293 开发者岗位包真人 Smoke 预备清单

这份清单用于 PR/HOTL gate 通过前的准备工作。它不替代正式 `AICS-293 Run developer package smoke`，也不能作为 `AICS-293` 的通过证据；正式 smoke 只能在 `AICS-291`、`AICS-292`、`AICS-294` 都完成后开始。

## Gate 状态

- `AICS-291`、`AICS-292`、`AICS-294` 必须先从 `in_review` 过 HOTL/PR gate 到 `done`。
- OpenClaw PR 覆盖开发者模式切换、模式状态、上下文隔离、`role_package` scanner 和本地 UI/协议测试。
- Mercur/Dijie PR 覆盖岗位 metadata 写入边界、admin/vendor safe projection、audit/readback 安全摘要。
- `AICS-293` 在 gate 通过前保持 planned/blocked，不提前 claim。

## 本地端预备

准备一个一次性 workspace 和一次性本地身份：

```text
deviceId:
workspaceRef:
localGatewayId:
OpenClaw URL:
cloudBaseUrl:
```

开发者模式入口必须是主对话的模式切换，不是第二套聊天框。进入后页面应能看到：

- 当前模式：`开发者模式`
- 当前角色：`岗位开发专属助手`
- 当前阶段：从 `等待业务逻辑` 开始
- 开场文案说明开发者只需要描述业务逻辑

开发者输入样例只写业务逻辑：

```text
我想做一个电商商品图检查岗位，给运营人员用。它看商品标题、主图和详情图，判断图片是否清晰、是否和标题一致、是否缺少关键卖点，然后给出需要修改的清单。
```

本地端必须确认：

- 开发者没有被要求填写 execution token、Gateway、RoleResult、AuditSummary、entitlement、审计上传、结算协议或云端 API。
- 输入、输出、规则、验收标准、包结构、协议映射、验证材料和上传标准由开发者模式资料包生成。
- `role_package/` 可下载或导出，并至少包含 `manifest.json`、`listing.md`、`README.md`、adapter/wrapper、validation/smoke 材料。
- 包内不包含 raw execution token、cloud bearer、provider key、secret 字段、本地绝对路径、使用者模式私有历史、订单/钱包/审核/结算状态。

## 云端联动预备

云端正式步骤仍以 Mercur/Dijie 的真人闭环 runbook 为准：

```text
dijie-role-marketplace/docs/dijie/human-closed-loop-runbook.md
```

正式 smoke 前准备：

```text
vendor/developer account:
admin account:
buyer/customer account:
authorization price CNY cents:
role token input cents per million:
role token output cents per million:
packageId:
packageVersion:
developerRef:
listingOwnerRef:
billingBeneficiaryRef:
```

云端预备检查：

- vendor 创建页可以填写授权价和岗位 Token 输入/输出单价。
- admin 审核页只展示公开 listing metadata、授权价和岗位 Token 单价。
- `metadata.dijieRole` 不保存 prompt、chat history、modeStage、workspace、execution、entitlement、order、wallet、provider secret 或本地路径。
- 缺少 `roleTokenPricing`、缺少开发者/结算归属、缺少 `modelProxyUsage` 都必须失败关闭，不能假成功。

## 正式 Smoke 顺序

1. 开发者进入 OpenClaw 主对话的开发者模式，只描述业务逻辑。
2. 主系统生成并确认业务规格，内部沉淀 `RoleBuildBrief`。
3. 主系统生成 `role_package/`，本地 scanner 通过。
4. 开发者上传岗位包到 developer center，填写公开 listing 和价格。
5. admin 审核并发布。
6. buyer 购买或授权岗位。
7. OpenClaw 通过云端事实请求 execution token。
8. 本地执行岗位，生成 `RoleResult` 和 `AuditSummary.modelProxyUsage`。
9. `/dijie/audit` 上传审计并派生 `role_usage` 开发者应收账。
10. `GET /dijie/executions/:executionId` 返回安全计费摘要。

## 停止条件

出现以下任一情况，停止 smoke 并回到对应任务修复：

- 开发者模式要求内部开发者填写平台协议字段。
- `role_package/` 包含 token、bearer、provider auth、secret、本地绝对路径或平台后端状态。
- 未购买或错误 buyer 能拿到 execution token。
- 缺 `roleTokenPricing` 的岗位能被审核、执行或结算。
- audit 上传失败但本地端报告成功。
- `role_usage` 中平台应收不为 0，或模型用量非零但开发者应收为 0。
- readback 暴露 raw token、cloud bearer、provider key、raw model payload、完整 stdout/stderr 或本地绝对路径。
