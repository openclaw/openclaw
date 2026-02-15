---
summary: "疑難排解節點配對、前景要求、權限和工具失敗問題"
read_when:
  - 節點已連線但相機/畫布/螢幕/執行工具失敗
  - 您需要節點配對與核准的思維模型
title: "節點疑難排解"
---

# 節點疑難排解

當節點在狀態中可見但節點工具失敗時，請使用此頁面。

## 命令階梯

```bash
openclaw status
openclaw gateway status
openclaw logs --follow
openclaw doctor
openclaw channels status --probe
```

然後執行節點特定檢查：

```bash
openclaw nodes status
openclaw nodes describe --node <idOrNameOrIp>
openclaw approvals get --node <idOrNameOrIp>
```

健康訊號：

- 節點已連線並為 `node` 角色配對。
- `nodes describe` 包含您正在呼叫的功能。
- 執行核准顯示預期模式/允許清單。

## 前景要求

`canvas.*`、`camera.*` 和 `screen.*` 僅在 iOS/Android 節點上於前景執行。

快速檢查和修正：

```bash
openclaw nodes describe --node <idOrNameOrIp>
openclaw nodes canvas snapshot --node <idOrNameOrIp>
openclaw logs --follow
```

如果您看到 `NODE_BACKGROUND_UNAVAILABLE`，請將節點應用程式帶到前景並重試。

## 權限矩陣

| 功能                           | iOS                                     | Android                                      | macOS 節點應用程式                | 常見失敗代碼           |
| :--------------------------- | :-------------------------------------- | :------------------------------------------- | :---------------------------- | :----------------------------- |
| `camera.snap`、`camera.clip` | 相機（+ 麥克風用於剪輯音訊）           | 相機（+ 麥克風用於剪輯音訊）                | 相機（+ 麥克風用於剪輯音訊） | `*_PERMISSION_REQUIRED`        |
| `screen.record`              | 螢幕錄影（+ 選用麥克風）             | 螢幕截圖提示（+ 選用麥克風）             | 螢幕錄影              | `*_PERMISSION_REQUIRED`        |
| `location.get`               | 使用中 或 永遠（取決於模式） | 依模式而定，前景/背景位置 | 位置權限           | `LOCATION_PERMISSION_REQUIRED` |
| `system.run`                 | 不適用（節點主機路徑）                    | 不適用（節點主機路徑）                         | 需要執行核准       | `SYSTEM_RUN_DENIED`            |

## 配對與核准

這些是不同的關卡：

1. **裝置配對**：此節點是否可以連線到 Gateway？
2. **執行核准**：此節點是否可以執行特定的 shell 命令？

快速檢查：

```bash
openclaw devices list
openclaw nodes status
openclaw approvals get --node <idOrNameOrIp>
openclaw approvals allowlist add --node <idOrNameOrIp> "/usr/bin/uname"
```

如果配對遺失，請先核准節點裝置。
如果配對正常但 `system.run` 失敗，請修正執行核准/允許清單。

## 常見節點錯誤代碼

- `NODE_BACKGROUND_UNAVAILABLE` → 應用程式在背景執行；請將其帶到前景。
- `CAMERA_DISABLED` → 節點設定中相機開關已停用。
- `*_PERMISSION_REQUIRED` → 缺少/拒絕作業系統權限。
- `LOCATION_DISABLED` → 位置模式已關閉。
- `LOCATION_PERMISSION_REQUIRED` → 未授予所要求的位置模式。
- `LOCATION_BACKGROUND_UNAVAILABLE` → 應用程式在背景執行但只有「使用中」權限。
- `SYSTEM_RUN_DENIED: approval required` → 執行要求需要明確核准。
- `SYSTEM_RUN_DENIED: allowlist miss` → 命令被允許清單模式封鎖。

## 快速復原循環

```bash
openclaw nodes status
openclaw nodes describe --node <idOrNameOrIp>
openclaw approvals get --node <idOrNameOrIp>
openclaw logs --follow
```

如果仍然卡住：

- 重新核准裝置配對。
- 重新開啟節點應用程式（前景）。
- 重新授予作業系統權限。
- 重新建立/調整執行核准政策。

相關：

- [/nodes/index](/nodes/index)
- [/nodes/camera](/nodes/camera)
- [/nodes/location-command](/nodes/location-command)
- [/tools/exec-approvals](/tools/exec-approvals)
- [/gateway/pairing](/gateway/pairing)
