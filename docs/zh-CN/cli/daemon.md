---
read_when:
  - 你在脚本里仍使用 `openclaw daemon ...`
  - 你需要服务生命周期命令（install/start/stop/restart/status）
summary: "`openclaw daemon` 的 CLI 参考（Gateway 服务管理的旧别名）"
title: daemon
---

# `openclaw daemon`

`openclaw daemon` 是 Gateway 服务管理命令的**旧别名**。

`openclaw daemon ...` 与 `openclaw gateway ...` 的服务控制面一致。

## 用法

```bash
openclaw daemon status
openclaw daemon install
openclaw daemon start
openclaw daemon stop
openclaw daemon restart
openclaw daemon uninstall
```

## 子命令

- `status`：显示服务安装状态并探测 Gateway 健康
- `install`：安装服务（`launchd` / `systemd` / `schtasks`）
- `uninstall`：卸载服务
- `start`：启动服务
- `stop`：停止服务
- `restart`：重启服务

## 常用选项

- `status`：`--url`、`--token`、`--password`、`--timeout`、`--no-probe`、`--deep`、`--json`
- `install`：`--port`、`--runtime <node|bun>`、`--token`、`--force`、`--json`
- 生命周期命令（`uninstall|start|stop|restart`）：`--json`

## 建议

优先使用 [`openclaw gateway`](/cli/gateway) 获取最新文档与示例。
