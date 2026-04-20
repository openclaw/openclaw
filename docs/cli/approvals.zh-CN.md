---
summary: "`openclaw approvals` 和 `openclaw exec-policy` 的CLI参考"
read_when:
  - 您想从CLI编辑exec批准
  - 您需要在gateway或node主机上管理允许列表
title: "approvals"
---

# `openclaw approvals`

管理**本地主机**、**gateway主机**或**node主机**的exec批准。
默认情况下，命令目标是磁盘上的本地批准文件。使用`--gateway`目标gateway，或使用`--node`目标特定的节点。

别名：`openclaw exec-approvals`

相关：

- Exec批准：[Exec approvals](/tools/exec-approvals)
- 节点：[Nodes](/nodes)

## `openclaw exec-policy`

`openclaw exec-policy`是本地便捷命令，用于在一步中保持请求的`tools.exec.*`配置和本地主机批准文件对齐。

当您想：

- 检查本地请求的策略、主机批准文件和有效的合并
- 应用本地预设，如YOLO或deny-all
- 同步本地`tools.exec.*`和本地`~/.openclaw/exec-approvals.json`

时使用它。

示例：

```bash
openclaw exec-policy show
openclaw exec-policy show --json

openclaw exec-policy preset yolo
openclaw exec-policy preset cautious --json

openclaw exec-policy set --host gateway --security full --ask off --ask-fallback full
```

输出模式：

- 无`--json`：打印人类可读的表格视图
- `--json`：打印机器可读的结构化输出

当前范围：

- `exec-policy`是**仅限本地**的
- 它一起更新本地配置文件和本地批准文件
- 它**不**将策略推送到gateway主机或node主机
- 此命令中拒绝`--host node`，因为节点exec批准在运行时从节点获取，必须通过节点目标的批准命令来管理
- `openclaw exec-policy show`将`host=node`范围标记为在运行时由节点管理，而不是从本地批准文件派生有效策略

如果您需要直接编辑远程主机批准，请继续使用`openclaw approvals set --gateway`或`openclaw approvals set --node <id|name|ip>`。

## 常用命令

```bash
openclaw approvals get
openclaw approvals get --node <id|name|ip>
openclaw approvals get --gateway
```

`openclaw approvals get`现在显示本地、gateway和节点目标的有效exec策略：

- 请求的`tools.exec`策略
- 主机批准文件策略
- 应用优先级规则后的有效结果

优先级是有意的：

- 主机批准文件是可执行的事实来源
- 请求的`tools.exec`策略可以缩小或扩大意图，但有效结果仍从主机规则派生
- `--node`结合节点主机批准文件和gateway `tools.exec`策略，因为两者在运行时仍然适用
- 如果gateway配置不可用，CLI回退到节点批准快照并注意无法计算最终运行时策略

## 从文件替换批准

```bash
openclaw approvals set --file ./exec-approvals.json
openclaw approvals set --stdin <<'EOF'
{ version: 1, defaults: { security: "full", ask: "off" } }
EOF
openclaw approvals set --node <id|name|ip> --file ./exec-approvals.json
openclaw approvals set --gateway --file ./exec-approvals.json
```

`set`接受JSON5，而不仅仅是严格的JSON。使用`--file`或`--stdin`，不要同时使用两者。

## "永不提示" / YOLO示例

对于永远不应该在exec批准上停止的主机，将主机批准默认设置为`full` + `off`：

```bash
openclaw approvals set --stdin <<'EOF'
{
  version: 1,
  defaults: {
    security: "full",
    ask: "off",
    askFallback: "full"
  }
}
EOF
```

节点变体：

```bash
openclaw approvals set --node <id|name|ip> --stdin <<'EOF'
{
  version: 1,
  defaults: {
    security: "full",
    ask: "off",
    askFallback: "full"
  }
}
EOF
```

这仅更改**主机批准文件**。要保持请求的OpenClaw策略对齐，还需设置：

```bash
openclaw config set tools.exec.host gateway
openclaw config set tools.exec.security full
openclaw config set tools.exec.ask off
```

为什么在此示例中使用`tools.exec.host=gateway`：

- `host=auto`仍然意味着"在可用时使用沙箱，否则使用gateway"。
- YOLO与批准有关，与路由无关。
- 如果您希望即使在配置了沙箱的情况下也执行主机exec，请使用`gateway`或`/exec host=gateway`明确选择主机。

这与当前的主机默认YOLO行为匹配。如果您需要批准，请加强它。

本地快捷方式：

```bash
openclaw exec-policy preset yolo
```

该本地快捷方式一起更新请求的本地`tools.exec.*`配置和本地批准默认值。它在意图上等同于上面的手动两步设置，但仅适用于本地机器。

## 允许列表助手

```bash
openclaw approvals allowlist add "~/Projects/**/bin/rg"
openclaw approvals allowlist add --agent main --node <id|name|ip> "/usr/bin/uptime"
openclaw approvals allowlist add --agent "*" "/usr/bin/uname"

openclaw approvals allowlist remove "~/Projects/**/bin/rg"
```

## 常用选项

`get`、`set`和`allowlist add|remove`都支持：

- `--node <id|name|ip>`
- `--gateway`
- 共享节点RPC选项：`--url`、`--token`、`--timeout`、`--json`

目标注意事项：

- 无目标标志意味着磁盘上的本地批准文件
- `--gateway`目标gateway主机批准文件
- `--node`在解析id、名称、IP或id前缀后目标一个节点主机

`allowlist add|remove`还支持：

- `--agent <id>`（默认为`*`）

## 注意事项

- `--node`使用与`openclaw nodes`相同的解析器（id、名称、ip或id前缀）。
- `--agent`默认为`"*"`，适用于所有代理。
- 节点主机必须通告`system.execApprovals.get/set`（macOS应用程序或无头节点主机）。
- 批准文件存储在每台主机的`~/.openclaw/exec-approvals.json`。
