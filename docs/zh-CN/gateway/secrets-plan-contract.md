---
summary: "`secrets apply` 计划合同：目标验证、路径匹配和 `auth-profiles.json` 目标范围"
read_when:
  - 生成或审查 `openclaw secrets apply` 计划
  - 调试 `Invalid plan target path` 错误
  - 了解目标类型和路径验证行为
title: "Secrets Apply 计划合同"
---

# Secrets apply 计划合同

此页面定义了 `openclaw secrets apply` 强制执行的严格合同。

如果目标不匹配这些规则，apply 将在修改配置之前失败。

## 计划文件格式

`openclaw secrets apply --from <plan.json>` 期望一个 `targets` 数组的计划目标：

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

计划目标在以下位置接受支持的凭证路径：

- [SecretRef 凭证表面](/reference/secretref-credential-surface)

## 目标类型行为

一般规则：

- `target.type` 必须被识别，并且必须与规范化的 `target.path` 形状匹配。

兼容性别名仍然被接受用于现有计划：

- `models.providers.apiKey`
- `skills.entries.apiKey`
- `channels.googlechat.serviceAccount`

## 路径验证规则

每个目标都通过以下所有验证：

- `type` 必须是可识别的目标类型。
- `path` 必须是非空的点路径。
- `pathSegments` 可以省略。如果提供，它必须规范化为与 `path` 完全相同的路径。
- 禁止的段被拒绝：`__proto__`、`prototype`、`constructor`。
- 规范化路径必须与目标类型注册 path 形状匹配。
- 如果设置了 `providerId` 或 `accountId`，它必须与路径中编码的 ID 匹配。
- `auth-profiles.json` 目标需要 `agentId`。
- 创建新的 `auth-profiles.json` 映射时，包含 `authProfileProvider`。

## 失败行为

如果目标验证失败，apply 退出并显示类似以下的错误：

```text
Invalid plan target path for models.providers.apiKey: models.providers.openai.baseUrl
```

无效计划不会提交任何写入。

## Exec 提供商同意行为

- `--dry-run` 默认跳过 exec SecretRef 检查。
- 包含 exec SecretRefs/提供商的计划在写入模式下被拒绝，除非设置了 `--allow-exec`。
- 在验证/应用包含 exec 的计划时，在 dry-run 和写入命令中都传递 `--allow-exec`。

## 运行时和审计范围说明

- 仅 ref 的 `auth-profiles.json` 条目（`keyRef`/`tokenRef`）包含在运行时解析和审计覆盖中。
- `secrets apply` 写入支持的 `openclaw.json` 目标、支持 `auth-profiles.json` 目标和可选的清理目标。

## 操作员检查

```bash
# 验证计划但不写入
openclaw secrets apply --from /tmp/openclaw-secrets-plan.json --dry-run

# 然后真正应用
openclaw secrets apply --from /tmp/openclaw-secrets-plan.json

# 对于包含 exec 的计划，在两种模式下都明确选择加入
openclaw secrets apply --from /tmp/openclaw-secrets-plan.json --dry-run --allow-exec
openclaw secrets apply --from /tmp/openclaw-secrets-plan.json --allow-exec
```

如果 apply 失败并显示无效的目标路径消息，请使用 `openclaw secrets configure` 重新生成计划或将目标路径修复为上面支持的形状。

## 相关文档

- [Secrets 管理](/gateway/secrets)
- [CLI `secrets`](/cli/secrets)
- [SecretRef 凭证表面](/reference/secretref-credential-surface)
- [配置参考](/gateway/configuration-reference)