---
summary: "`openclaw daemon` CLI 参考（Gateway 服务管理的旧别名）"
read_when:
  - 脚本中仍在使用 `openclaw daemon ...`
  - 需要服务生命周期管理命令（安装/启动/停止/重启/状态）
title: "daemon"
---

# `openclaw daemon`

Gateway 服务管理命令的旧别名。

`openclaw daemon ...` 与 `openclaw gateway ...` 的服务控制功能完全相同。

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

- `status`：显示服务安装状态并探测 Gateway 健康状况
- `install`：安装服务（`launchd`/`systemd`/`schtasks`）
- `uninstall`：移除服务
- `start`：启动服务
- `stop`：停止服务
- `restart`：重启服务

## 常用选项

- `status`：`--url`、`--token`、`--password`、`--timeout`、`--no-probe`、`--deep`、`--json`
- `install`：`--port`、`--runtime <node|bun>`、`--token`、`--force`、`--json`
- 生命周期命令（`uninstall|start|stop|restart`）：`--json`

## 推荐

请使用 [`openclaw gateway`](/cli/gateway) 查看最新文档和示例。
