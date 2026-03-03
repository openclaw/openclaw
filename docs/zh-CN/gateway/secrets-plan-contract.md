---
summary: "`secrets apply` 计划契约：目标验证、路径匹配和 `auth-profiles.json` 目标范围"
read_when:
  - 生成或审查 `openclaw secrets apply` 计划
  - 调试 `Invalid plan target path` 错误
  - 了解目标类型和路径验证行为
title: "Secrets Apply 计划契约"
---

# Secrets Apply 计划契约

本页定义 `openclaw secrets apply` 执行的严格契约。

如果目标不符合这些规则，apply 会在修改配置之前失败。

## 计划文件结构

`openclaw secrets apply --from <plan.json>` 期望一个包含 `targets` 数组的计划文件：

```json5
{
  version: 1,
  protocolVersion: 1,
  targets: [
    {
      type: "models.providers.apiKey",
      path: "models.providers.openai.apiKey",
      pathSegments: ["models", "providers", "openai", "apiKey"],
      providerId: "openai",
      ref: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
    },
    {
      type: "auth-profiles.api_key.key",
      path: "profiles.openai:default.key",
      pathSegments: ["profiles", "openai:default", "key"],
      agentId: "main",
      ref: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
    },
  ],
}
```

## 支持的目标范围

计划目标适用于以下位置的受支持凭证路径：

- [SecretRef 凭证范围](/reference/secretref-credential-surface)

## 目标类型行为

通用规则：

- `target.type` 必须是已识别的类型，且必须与规范化的 `target.path` 形状匹配。

为兼容现有计划保留的别名：

- `models.providers.apiKey`
- `skills.entries.apiKey`
- `channels.googlechat.serviceAccount`

## 路径验证规则

每个目标按以下规则全部验证：

- `type` 必须是已识别的目标类型。
- `path` 必须是非空的点分路径。
- `pathSegments` 可省略。如果提供，必须规范化为与 `path` 完全相同的路径。
- 禁止的段会被拒绝：`__proto__`、`prototype`、`constructor`。
- 规范化路径必须匹配目标类型注册的路径形状。
- 如果设置了 `providerId` 或 `accountId`，必须与路径中编码的 id 匹配。
- `auth-profiles.json` 目标需要 `agentId`。
- 创建新的 `auth-profiles.json` 映射时，需包含 `authProfileProvider`。

## 失败行为

如果目标验证失败，apply 会输出类似错误退出：

```text
Invalid plan target path for models.providers.apiKey: models.providers.openai.baseUrl
```

无效计划不会提交任何写入。

## 运行时和审计范围说明

- 仅引用的 `auth-profiles.json` 条目（`keyRef`/`tokenRef`）包含在运行时解析和审计覆盖范围内。
- `secrets apply` 写入受支持的 `openclaw.json` 目标、受支持的 `auth-profiles.json` 目标和可选的清理目标。

## 操作检查

```bash
# 验证计划但不写入
openclaw secrets apply --from /tmp/openclaw-secrets-plan.json --dry-run

# 然后实际应用
openclaw secrets apply --from /tmp/openclaw-secrets-plan.json
```

如果 apply 因无效目标路径消息失败，使用 `openclaw secrets configure` 重新生成计划，或将目标路径修复为上述支持的形状。

## 相关文档

- [密钥管理](/gateway/secrets)
- [CLI `secrets`](/cli/secrets)
- [SecretRef 凭证范围](/reference/secretref-credential-surface)
- [配置参考](/gateway/configuration-reference)
