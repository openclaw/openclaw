---
summary: "`openclaw status` 命令行参考（诊断、探测、使用快照）"
read_when:
  - 你想快速诊断频道健康状况和最近的会话接收者
  - 你想获得可粘贴的“全部”状态用于调试
title: "status"
---

# `openclaw status`

频道和会话的诊断。

```bash
openclaw status
openclaw status --all
openclaw status --deep
openclaw status --usage
```

注意：

- `--deep` 运行实时探测（WhatsApp Web + Telegram + Discord + Slack + Signal）。
- `--usage` 以 `X% left` 的形式打印标准化的提供商使用窗口。
- MiniMax 的原始 `usage_percent` / `usagePercent` 字段是剩余配额，因此 OpenClaw 在显示前将其反转；当存在基于计数的字段时，它们优先。`model_remains` 响应优先选择聊天模型条目，在需要时从时间戳派生窗口标签，并在计划标签中包含模型名称。
- 当当前会话快照稀疏时，`/status` 可以从最近的转录使用日志中回填令牌和缓存计数器。现有的非零实时值仍然优先于转录回退值。
- 当活动会话条目缺少活动运行时模型标签时，转录回退也可以恢复该标签。如果该转录模型与选定模型不同，状态会根据恢复的运行时模型而不是选定的模型解析上下文窗口。
- 对于提示大小计算，当会话元数据缺失或较小时，转录回退优先选择较大的面向提示的总数，因此自定义提供商会话不会崩溃为 `0` 令牌显示。
- 当配置了多个代理时，输出包括每个代理的会话存储。
- 概述包括可用时的网关和节点主机服务安装/运行时状态。
- 概述包括更新频道和 git SHA（对于源代码 checkout）。
- 更新信息显示在概述中；如果有可用更新，状态会打印提示以运行 `openclaw update`（请参阅 [更新](/install/updating)）。
- 只读状态表面（`status`、`status --json`、`status --all`）在可能的情况下解析其目标配置路径的支持 SecretRef。
- 如果配置了支持的频道 SecretRef 但在当前命令路径中不可用，状态保持只读并报告降级输出而不是崩溃。人类输出显示警告，如“在此命令路径中配置的令牌不可用”，JSON 输出包括 `secretDiagnostics`。
- 当命令本地 SecretRef 解析成功时，状态优先使用解析的快照并从最终输出中清除临时的“密钥不可用”频道标记。
- `status --all` 包括一个 Secrets 概述行和一个诊断部分，该部分总结了密钥诊断（为可读性而截断），而不会停止报告生成。