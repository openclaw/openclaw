---
title: "认证凭证语义"
summary: "认证配置文件的规范凭证 eligibility 和解析语义"
read_when:
  - 处理认证配置文件解析或凭证路由工作时
  - 调试模型认证失败或配置文件顺序时
---

# 认证凭证语义

本文档定义了在以下各处使用的规范凭证 eligibility 和解析语义：

- `resolveAuthProfileOrder`
- `resolveApiKeyForProfile`
- `models status --probe`
- `doctor-auth`

目标是保持选择时和运行时行为保持一致。

## 稳定的探测原因代码

- `ok`
- `excluded_by_auth_order`
- `missing_credential`
- `invalid_expires`
- `expired`
- `unresolved_ref`
- `no_model`

## 令牌凭证

令牌凭证（`type: "token"`）支持内联 `token` 和/或 `tokenRef`。

### 资格规则

1. 当 `token` 和 `tokenRef` 都缺失时，令牌配置文件不合格。
2. `expires` 是可选的。
3. 如果存在 `expires`，则必须是一个大于 `0` 的有限数。
4. 如果 `expires` 无效（`NaN`、`0`、负数、非有限数或类型错误），配置文件不合格，原因为 `invalid_expires`。
5. 如果 `expires` 已过期，配置文件不合格，原因为 `expired`。
6. `tokenRef` 不绕过 `expires` 验证。

### 解析规则

1. 解析器语义与 `expires` 的资格语义相匹配。
2. 对于符合条件的配置文件，令牌材料可以从内联值或 `tokenRef` 解析。
3. 无法解析的引用在 `models status --probe` 输出中产生 `unresolved_ref`。

## 显式认证顺序过滤

- 当为某个提供程序设置了 `auth.order.<provider>` 或认证存储顺序覆盖时，`models status --probe` 仅探测保留在该提供程序解析后的认证顺序中的配置文件ID。
- 该提供程序未包含在显式顺序中的存储配置文件不会在后面被静默尝试。探测输出将其报告为 `reasonCode: excluded_by_auth_order` 和详细信息 `Excluded by auth.order for this provider.`

## 探测目标解析

- 探测目标可以来自认证配置文件、环境凭证或 `models.json`。
- 如果某个提供程序有凭证，但 OpenClaw 无法为其解析出可探测的模型候选项，`models status --probe` 报告 `status: no_model` 以及 `reasonCode: no_model`。

## OAuth SecretRef 策略防护

- SecretRef 输入仅用于静态凭证。
- 如果配置文件凭证是 `type: "oauth"`，则该配置文件凭证材料不支持 SecretRef 对象。
- 如果 `auth.profiles.<id>.mode` 是 `"oauth"`，则该配置文件的基于 SecretRef 的 `keyRef`/`tokenRef` 输入将被拒绝。
- 违规是启动/重新加载认证解析路径中的严重失败。

## 旧版兼容消息传递

为了脚本兼容性，探测错误保持第一行不变：

`Auth profile credentials are missing or expired.`

可以在后续行中添加用户友好的详细信息和稳定的原因代码。
