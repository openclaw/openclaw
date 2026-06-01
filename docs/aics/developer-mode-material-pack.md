---
summary: "Built-in materials for Dijie developer mode role-package generation"
title: "Developer Mode Material Pack"
---

# 迭界AI开发者模式内置资料包

这份资料包给开发者模式助手使用，不要求普通开发者阅读。开发者只需要描述业务逻辑；输入、输出、规则、验收标准、岗位包结构、协议映射、验证材料和上传标准都是平台职责，由开发者模式流程用这份资料包自动处理成可上传开发者中心的完整岗位包。

## Conversation Intake

开发者模式只向开发者收集自然语言业务逻辑，不要求开发者按平台字段填表，也不要求开发者定义输入、输出、规则或验收标准。下面这些项目是平台内置资料包和开发者模式流程的内部处理维度，用来自动把业务逻辑转成岗位包规格：

- 岗位名称和目标用户
- 要解决的业务问题
- 输入材料、输入字段和输入格式
- 输出内容、输出字段和输出格式
- 业务步骤和判断规则
- 异常、拒绝、需要人工确认的场景
- 成功标准和失败标准
- 测试样例和验收标准
- 上架说明、使用限制和定价意图

不要向开发者索要这些维度作为参数，也不要要求开发者逐项确认这些平台标准。只有业务逻辑本身不清楚时，才用业务语言追问业务事实；岗位包标准由平台内置资料包自动生成和校验。

不要向开发者询问这些平台细节：

- execution token
- Gateway method
- RoleResult
- AuditSummary
- entitlement
- audit upload endpoint
- cloud bearer
- deviceId / workspaceRef / localGatewayId
- roleTokenPricing schema
- settlement ledger schema

开发者模式助手本身也不应接收这些云端上下文作为提示词材料。`executionId`、`actorId`、`entitlementId`、订单引用、钱包状态、结算快照和审核状态只允许在平台桥、审计构建器、结算派生器和云端 API 内部流转。

## RoleBuildBrief Shape

业务逻辑清楚后，主系统把多轮对话沉淀成内部 `RoleBuildBrief`。这是平台内部结构，不是开发者要填写的表单。字段可以按实现演进，但至少要表达：

```json
{
  "name": "岗位名称",
  "targetUsers": ["谁会使用这个岗位"],
  "businessGoal": "岗位解决的业务问题",
  "inputs": ["输入材料或字段"],
  "outputs": ["输出结果或文件"],
  "workflow": ["步骤一", "步骤二", "步骤三"],
  "rules": ["业务判断规则"],
  "edgeCases": ["异常和拒绝条件"],
  "humanReview": ["需要人工确认的点"],
  "acceptanceCriteria": ["可验证的合格标准"],
  "testCases": ["样例输入和预期输出"],
  "listingDraft": {
    "title": "开发者中心展示标题",
    "summary": "岗位能力摘要",
    "limitations": ["使用限制"]
  }
}
```

## External Developer Standards

如果开发者不用迭界AI开发者模式，而是用其他软件或团队自行开发岗位包，可以向他们公开平台标准。此时输入、输出、业务规则、异常处理、验收标准、测试样例和 `role_package/` 目录结构可以作为外部开发规范使用。

这个规范面向外部开发，不改变开发者模式的体验：在迭界AI内部开发时，开发者仍然只需要表达业务逻辑；岗位包标准、结构、协议和验证全部由平台内置资料包与开发者模式流程处理。

## Required Package Layout

生成产物必须位于 `role_package/`：

```text
role_package/
  manifest.json
  listing.md
  README.md
  adapters/
    openclaw-adapter.ts
  validation/
    smoke-test.md
```

最低要求：

- `manifest.json` 是机器可读清单，包含岗位包 ID、版本、入口、能力、输入输出、权限和验证信息。
- `listing.md` 是开发者中心审核和展示用说明。
- `README.md` 说明本岗位包如何运行、输入输出是什么、如何验证。
- `adapters/` 或同级示例文件说明主系统如何调用岗位包。
- `validation/` 说明 smoke test 或验收步骤。

## Platform-Owned Details

这些事情由平台处理，岗位包不需要实现：

- 云端登录和身份校验
- execution token 签发和验签
- Gateway RPC
- entitlement 校验
- 设备、workspace、本地 Gateway 绑定
- RoleResult / AuditSummary 外层上传协议
- Token 计费、开发者应收、平台应收
- 开发者中心上传、审核、发布状态机

岗位包只负责岗位业务逻辑、必要适配层和验证材料。

## Security Rules

岗位包禁止包含：

- provider key 名称或值
- 任何 `secret` / `apiKey` / `providerKey` / token 字段
- cloud bearer 或 raw execution token
- 用户完整主对话历史
- 使用者模式私有记忆
- 本地绝对路径
- executionId、actorId、entitlementId、订单、钱包、审核、结算等平台后端 ID 或状态

如果业务需要外部凭证，只能用业务语言说明“由平台凭证能力注入”，不能在岗位包里写具体 provider key 名称、secret 字段或凭证值。
