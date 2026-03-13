---
summary: >-
  CLI reference for `openclaw daemon` (legacy alias for gateway service
  management)
read_when:
  - You still use `openclaw daemon ...` in scripts
  - You need service lifecycle commands (install/start/stop/restart/status)
title: daemon
---

# `openclaw daemon`

舊版別名用於網關服務管理命令。

`openclaw daemon ...` 對應到與 `openclaw gateway ...` 服務指令相同的服務控制介面。

## 使用方式

```bash
openclaw daemon status
openclaw daemon install
openclaw daemon start
openclaw daemon stop
openclaw daemon restart
openclaw daemon uninstall
```

## Subcommands

- `status`: 顯示服務安裝狀態並探測 Gateway 健康狀況
- `install`: 安裝服務 (`launchd`/`systemd`/`schtasks`)
- `uninstall`: 移除服務
- `start`: 啟動服務
- `stop`: 停止服務
- `restart`: 重新啟動服務

## 常見選項

- `status`: `--url`, `--token`, `--password`, `--timeout`, `--no-probe`, `--deep`, `--json`
- `install`: `--port`, `--runtime <node|bun>`, `--token`, `--force`, `--json`
- lifecycle (`uninstall|start|stop|restart`): `--json`

Notes:

- `status` 會在可能的情況下解析設定的認證 SecretRefs 以用於探針認證。
- 在 Linux systemd 安裝中，`status` token-drift 檢查包括 `Environment=` 和 `EnvironmentFile=` 單元來源。
- 當 token 認證需要一個 token 且 `gateway.auth.token` 是由 SecretRef 管理時，`install` 會驗證 SecretRef 是否可解析，但不會將解析後的 token 持久化到服務環境元數據中。
- 如果 token 認證需要一個 token 且設定的 token SecretRef 無法解析，安裝將會失敗並關閉。
- 如果同時設定了 `gateway.auth.token` 和 `gateway.auth.password` 且 `gateway.auth.mode` 未設置，安裝將被阻止，直到模式被明確設置。

## Prefer

使用 [`openclaw gateway`](/cli/gateway) 獲取最新的文件和範例。
