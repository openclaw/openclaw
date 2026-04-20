---
summary: "`openclaw daemon`的CLI参考（Gateway服务管理的旧别名）"
read_when:
  - 您仍然在脚本中使用`openclaw daemon ...`
  - 您需要服务生命周期命令（install/start/stop/restart/status）
title: "daemon"
---

# `openclaw daemon`

Gateway服务管理命令的旧别名。

`openclaw daemon ...`映射到与`openclaw gateway ...`服务命令相同的服务控制表面。

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

- `status`: 显示服务安装状态并探测Gateway健康状况
- `install`: 安装服务（`launchd`/`systemd`/`schtasks`）
- `uninstall`: 移除服务
- `start`: 启动服务
- `stop`: 停止服务
- `restart`: 重启服务

## 常用选项

- `status`: `--url`, `--token`, `--password`, `--timeout`, `--no-probe`, `--require-rpc`, `--deep`, `--json`
- `install`: `--port`, `--runtime <node|bun>`, `--token`, `--force`, `--json`
- 生命周期（`uninstall|start|stop|restart`）: `--json`

注意事项：

- `status`在可能时解析配置的认证SecretRef用于探测认证。
- 如果在此命令路径中需要的认证SecretRef未解析，`daemon status --json`在探测连接/认证失败时报告`rpc.authWarning`；请显式传递`--token`/`--password`或首先解析秘密源。
- 如果探测成功，未解析的auth-ref警告会被抑制以避免误报。
- `status --deep`添加尽力而为的系统级服务扫描。当它发现其他类似gateway的服务时，人类输出会打印清理提示并警告每台机器一个gateway仍然是正常推荐。
- 在Linux systemd安装中，`status`令牌漂移检查包括`Environment=`和`EnvironmentFile=`单元源。
- 漂移检查使用合并的运行时环境解析`gateway.auth.token` SecretRef（服务命令环境优先，然后是进程环境回退）。
- 如果令牌认证未有效激活（显式`gateway.auth.mode`为`password`/`none`/`trusted-proxy`，或模式未设置，其中密码可以获胜且没有令牌候选可以获胜），令牌漂移检查会跳过配置令牌解析。
- 当令牌认证需要令牌且`gateway.auth.token`由SecretRef管理时，`install`验证SecretRef是否可解析，但不会将解析的令牌持久化到服务环境元数据中。
- 如果令牌认证需要令牌且配置的令牌SecretRef未解析，安装会失败关闭。
- 如果同时配置了`gateway.auth.token`和`gateway.auth.password`且`gateway.auth.mode`未设置，安装会被阻止，直到明确设置模式。
- 如果您有意在一台主机上运行多个gateway，请隔离端口、配置/状态和工作区；请参阅[/gateway#multiple-gateways-same-host](/gateway#multiple-gateways-same-host)。

## 首选

使用[`openclaw gateway`](/cli/gateway)获取当前文档和示例。
