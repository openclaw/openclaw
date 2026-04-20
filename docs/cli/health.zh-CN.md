---
summary: "`openclaw health`的CLI参考（通过RPC的gateway健康快照）"
read_when:
  - 您想快速检查运行中的Gateway的健康状况
title: "health"
---

# `openclaw health`

从运行中的Gateway获取健康状况。

选项：

- `--json`: 机器可读输出
- `--timeout <ms>`: 连接超时（毫秒）（默认`10000`）
- `--verbose`: 详细日志
- `--debug`: `--verbose`的别名

示例：

```bash
openclaw health
openclaw health --json
openclaw health --timeout 2500
openclaw health --verbose
openclaw health --debug
```

注意事项：

- 默认的`openclaw health`向运行中的gateway请求其健康快照。当gateway已经有新鲜的缓存快照时，它可以返回该缓存的负载并在后台刷新。
- `--verbose`强制实时探测，打印gateway连接详情，并在所有配置的账户和代理上展开人类可读的输出。
- 当配置了多个代理时，输出包括每个代理的会话存储。