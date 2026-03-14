---
summary: "`openclaw daemon` CLI 参考（gateway 服务管理的遗留别名）"
read_when:
  - 你仍在脚本中使用 `openclaw daemon ...`
  - 你需要服务生命周期命令 (install/start/stop/restart/status)
title: "daemon"
---

# `openclaw daemon`

Gateway 服务管理命令的遗留别名。

`openclaw daemon ...` 映射到与 `openclaw gateway ...` 服务命令相同的服务控制面。

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

- `status`: 显示服务安装状态并探测 Gateway 健康状态
- `install`: 安装服务 (`launchd`/`systemd`/`schtasks`)
- `uninstall`: 移除服务
- `start`: 启动服务
- `stop`: 停止服务
- `restart`: 重启服务

## 常用选项

- `status`: `--url`, `--token`, `--password`, `--timeout`, `--no-probe`, `--deep`, `--json`
- `install`: `--port`, `--runtime <node|bun>`, `--token`, `--force`, `--json`
- lifecycle (`uninstall|start|stop|restart`): `--json`

## 推荐

使用 [`openclaw gateway`](/cli/gateway) 获取当前文档和示例。
