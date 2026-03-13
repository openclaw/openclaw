---
summary: >-
  Troubleshoot node pairing, foreground requirements, permissions, and tool
  failures
read_when:
  - Node is connected but camera/canvas/screen/exec tools fail
  - You need the node pairing versus approvals mental model
title: Node Troubleshooting
---

# 節點故障排除

當節點在狀態中可見但節點工具失效時，請使用此頁面。

## 指令階梯

```bash
openclaw status
openclaw gateway status
openclaw logs --follow
openclaw doctor
openclaw channels status --probe
```

接著執行節點特定檢查：

```bash
openclaw nodes status
openclaw nodes describe --node <idOrNameOrIp>
openclaw approvals get --node <idOrNameOrIp>
```

健康訊號：

- 節點已連線並配對為角色 `node`。
- `nodes describe` 包含您正在呼叫的功能。
- 執行授權顯示預期的模式/允許清單。

## 前景需求

`canvas.*`、`camera.*` 和 `screen.*` 僅限 iOS/Android 節點在前景執行。

快速檢查與修復：

```bash
openclaw nodes describe --node <idOrNameOrIp>
openclaw nodes canvas snapshot --node <idOrNameOrIp>
openclaw logs --follow
```

如果您看到 `NODE_BACKGROUND_UNAVAILABLE`，請將節點應用程式切換到前景並重試。

## 權限矩陣

| 功能                         | iOS                        | Android                      | macOS 節點應用程式       | 典型失敗程式碼                 |
| ---------------------------- | -------------------------- | ---------------------------- | ------------------------ | ------------------------------ |
| `camera.snap`、`camera.clip` | 相機（剪輯音訊需麥克風）   | 相機（剪輯音訊需麥克風）     | 相機（剪輯音訊需麥克風） | `*_PERMISSION_REQUIRED`        |
| `screen.record`              | 螢幕錄製（麥克風為選用）   | 螢幕擷取提示（麥克風為選用） | 螢幕錄製                 | `*_PERMISSION_REQUIRED`        |
| `location.get`               | 使用中或永遠（依模式而定） | 根據模式前景/背景定位        | 位置權限                 | `LOCATION_PERMISSION_REQUIRED` |
| `system.run`                 | 不適用（節點主機路徑）     | 不適用（節點主機路徑）       | 需執行授權               | `SYSTEM_RUN_DENIED`            |

## 配對與授權的差異

這些是不同的關卡：

1. **裝置配對**：此節點能否連接到閘道器？
2. **執行授權**：此節點能否執行特定的 shell 指令？

快速檢查：

```bash
openclaw devices list
openclaw nodes status
openclaw approvals get --node <idOrNameOrIp>
openclaw approvals allowlist add --node <idOrNameOrIp> "/usr/bin/uname"
```

如果缺少配對，請先核准節點裝置。
如果配對正常但 `system.run` 失敗，請修正執行授權/允許清單。

## 常見節點錯誤程式碼

- `NODE_BACKGROUND_UNAVAILABLE` → 應用程式在背景執行；請切換到前景。
- `CAMERA_DISABLED` → 節點設定中相機切換被禁用。
- `*_PERMISSION_REQUIRED` → 作業系統權限缺失或被拒絕。
- `LOCATION_DISABLED` → 位置模式已關閉。
- `LOCATION_PERMISSION_REQUIRED` → 請求的定位模式未被授權。
- `LOCATION_BACKGROUND_UNAVAILABLE` → 應用程式在背景執行，但只有「使用期間」權限。
- `SYSTEM_RUN_DENIED: approval required` → 執行請求需要明確授權。
- `SYSTEM_RUN_DENIED: allowlist miss` → 指令被允許清單模式阻擋。
  在 Windows 節點主機上，像 `cmd.exe /c ...` 這類 shell-wrapper 形式在允許清單模式下會被視為允許清單缺失，除非透過詢問流程核准。

## 快速復原流程

```bash
openclaw nodes status
openclaw nodes describe --node <idOrNameOrIp>
openclaw approvals get --node <idOrNameOrIp>
openclaw logs --follow
```

如果仍然卡住：

- 重新核准裝置配對。
- 重新開啟節點應用程式（前景執行）。
- 重新授予作業系統權限。
- 重新建立或調整執行授權政策。

相關連結：

- [/nodes/index](/nodes/index)
- [/nodes/camera](/nodes/camera)
- [/nodes/location-command](/nodes/location-command)
- [/tools/exec-approvals](/tools/exec-approvals)
- [/gateway/pairing](/gateway/pairing)
