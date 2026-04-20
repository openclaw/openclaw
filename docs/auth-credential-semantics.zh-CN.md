---
title: "认证凭证语义"
summary: "认证配置文件的规范凭证资格和解析语义"
read_when:
  - 处理认证配置文件解析或凭证路由
  - 调试模型认证失败或配置文件顺序
---

# 认证凭证语义

本文档定义了在以下场景中使用的规范凭证资格和解析语义：

- `resolveAuthProfileOrder`
- `resolveApiKeyForProfile`
- `models status --probe`
- `doctor-auth`

目标是保持选择时和运行时行为一致。

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

1. 当 `token` 和 `tokenRef` 都不存在时，令牌配置文件不符合资格。
2. `expires` 是可选的。
3. 如果存在 `expires`，它必须是大于 `0` 的有限数字。
4. 如果 `expires` 无效（`NaN`、`0`、负数、非有限或类型错误），配置文件不符合资格，原因代码为 `invalid_expires`。
5. 如果 `expires` 在过去，配置文件不符合资格，原因代码为 `expired`。
6. `tokenRef` 不会绕过 `expires` 验证。

### 解析规则

1. 解析器语义与 `expires` 的资格语义匹配。
2. 对于符合资格的配置文件，令牌材料可以从内联值或 `tokenRef` 解析。
3. 无法解析的引用在 `models status --probe` 输出中产生 `unresolved_ref`。

## 显式认证顺序过滤

- 当为提供者设置 `auth.order.<provider>` 或认证存储顺序覆盖时，`models status --probe` 仅探测该提供者的已解析认证顺序中保留的配置文件 ID。
- 该提供者的存储配置文件如果被排除在显式顺序之外，不会在稍后静默尝试。探测输出会将其报告为 `reasonCode: excluded_by_auth_order`，详细信息为 `Excluded by auth.order for this provider.`。

## 探测目标解析

- 探测目标可以来自认证配置文件、环境凭证或 `models.json`。
- 如果提供者有凭证但 OpenClaw 无法为其解析可探测的模型候选，`models status --probe` 会报告 `status: no_model` 并附带 `reasonCode: no_model`。

## OAuth SecretRef 策略守卫

- SecretRef 输入仅用于静态凭证。
- 如果配置文件凭证是 `type: "oauth"`，则该配置文件凭证材料不支持 SecretRef 对象。
- 如果 `auth.profiles.<id>.mode` 是 `"oauth"`，则拒绝该配置文件的 SecretRef 支持的 `keyRef`/`tokenRef` 输入。
- 违规在启动/重新加载认证解析路径中是硬性失败。

## 向后兼容的消息

为了脚本兼容性，探测错误保持第一行不变：

`Auth profile credentials are missing or expired.`

人类友好的详细信息和稳定的原因代码可以在后续行添加。
