---
summary: "排除節點配對、前景需求、權限以及工具失敗的疑難排解"
read_when:
  - "節點已連線，但相機/畫布/螢幕/執行工具失敗時"
  - "當您需要瞭解節點配對與核准的心理模型時"
title: "節點疑難排解"
---

# 節點疑難排解

當節點在狀態中可見，但節點工具失敗時，請參考此頁面。

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

- 節點已連線並以 `node` 角色完成配對。
- `nodes describe` 包含您正在呼叫的功能。
- 執行核准顯示預期的模式/允許清單。

## 前景需求

`canvas.*`、`camera.*` 與 `screen.*` 在 iOS/Android 節點上僅限前景運作。

快速檢查與修正：

```bash
openclaw nodes describe --node <idOrNameOrIp>
openclaw nodes canvas snapshot --node <idOrNameOrIp>
openclaw logs --follow
```

如果您看到 `NODE_BACKGROUND_UNAVAILABLE`，請將節點應用程式移至前景並重試。

## 權限矩陣

| 功能                         | iOS                              | Android                        | macOS 節點應用程式             | 典型失敗代碼                   |
| ---------------------------- | -------------------------------- | ------------------------------ | ------------------------------ | ------------------------------ |
| `camera.snap`, `camera.clip` | 相機（+ 剪輯音訊所需的麥克風）   | 相機（+ 剪輯音訊所需的麥克風） | 相機（+ 剪輯音訊所需的麥克風） | `*_PERMISSION_REQUIRED`        |
| `screen.record`              | 螢幕錄製（+ 麥克風選填）         | 螢幕擷取提示（+ 麥克風選填）   | 螢幕錄製                       | `*_PERMISSION_REQUIRED`        |
| `location.get`               | 使用期間或始終允許（取決於模式） | 根據模式提供前景/背景位置      | 位置權限                       | `LOCATION_PERMISSION_REQUIRED` |
| `system.run`                 | 不適用（節點主機路徑）           | 不適用（節點主機路徑）         | 需要執行核准                   | `SYSTEM_RUN_DENIED`            |

## 配對與核准

這是不同的關卡：

1. **裝置配對**：此節點是否可以連線到 Gateway？
2. **執行核准**：此節點是否可以執行特定的 shell 指令？

快速檢查：

```bash
openclaw devices list
openclaw nodes status
openclaw approvals get --node <idOrNameOrIp>
openclaw approvals allowlist add --node <idOrNameOrIp> "/usr/bin/uname"
```

如果缺少配對，請先核准節點裝置。
如果配對正常但 `system.run` 失敗，請修正執行核准/允許清單。

## 常見節點錯誤代碼

- `NODE_BACKGROUND_UNAVAILABLE` → 應用程式處於背景；請將其移至前景。
- `CAMERA_DISABLED` → 節點設定中禁用了相機切換開關。
- `*_PERMISSION_REQUIRED` → 缺少 OS 權限或已被拒絕。
- `LOCATION_DISABLED` → 位置模式已關閉。
- `LOCATION_PERMISSION_REQUIRED` → 未授予請求的位置模式。
- `LOCATION_BACKGROUND_UNAVAILABLE` → 應用程式處於背景，但僅擁有「使用期間」權限。
- `SYSTEM_RUN_DENIED: approval required` → 執行請求需要明確核准。
- `SYSTEM_RUN_DENIED: allowlist miss` → 指令被允許清單模式阻擋。

## 快速恢復迴圈

```bash
openclaw nodes status
openclaw nodes describe --node <idOrNameOrIp>
openclaw approvals get --node <idOrNameOrIp>
openclaw logs --follow
```

如果仍然卡住：

- 重新核准裝置配對。
- 重新開啟節點應用程式（前景）。
- 重新授予 OS 權限。
- 重新建立/調整執行核准策略。

相關內容：

- [/nodes/index](/nodes/index)
- [/nodes/camera](/nodes/camera)
- [/nodes/location-command](/nodes/location-command)
- [/tools/exec-approvals](/tools/exec-approvals)
- [/gateway/pairing](/gateway/pairing)
