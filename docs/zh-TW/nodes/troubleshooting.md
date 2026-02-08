---
summary: "針對節點配對、前景需求、權限與工具失敗進行疑難排解"
read_when:
  - 節點已連線，但相機／畫布／螢幕／exec 工具失敗
  - 你需要理解「節點配對」與「核准」的心智模型差異
title: "節點疑難排解"
x-i18n:
  source_path: nodes/troubleshooting.md
  source_hash: 5c40d298c9feaf8e
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:28:35Z
---

# 節點疑難排解

當節點在狀態中可見，但節點工具失敗時，請使用此頁面。

## 指令階梯

```bash
openclaw status
openclaw gateway status
openclaw logs --follow
openclaw doctor
openclaw channels status --probe
```

接著執行節點專屬檢查：

```bash
openclaw nodes status
openclaw nodes describe --node <idOrNameOrIp>
openclaw approvals get --node <idOrNameOrIp>
```

健康訊號：

- 節點已連線，且已為角色 `node` 完成配對。
- `nodes describe` 包含你正在呼叫的能力。
- Exec 核准顯示為預期的模式／允許清單。

## 前景需求

`canvas.*`、`camera.*` 與 `screen.*` 在 iOS／Android 節點上僅能於前景使用。

快速檢查與修正：

```bash
openclaw nodes describe --node <idOrNameOrIp>
openclaw nodes canvas snapshot --node <idOrNameOrIp>
openclaw logs --follow
```

如果你看到 `NODE_BACKGROUND_UNAVAILABLE`，請將節點 App 切換到前景後再試一次。

## 權限矩陣

| 能力                         | iOS                          | Android                    | macOS 節點 App           | 常見失敗代碼                   |
| ---------------------------- | ---------------------------- | -------------------------- | ------------------------ | ------------------------------ |
| `camera.snap`、`camera.clip` | 相機（剪輯音訊需麥克風）     | 相機（剪輯音訊需麥克風）   | 相機（剪輯音訊需麥克風） | `*_PERMISSION_REQUIRED`        |
| `screen.record`              | 螢幕錄製（麥克風選用）       | 螢幕擷取提示（麥克風選用） | 螢幕錄製                 | `*_PERMISSION_REQUIRED`        |
| `location.get`               | 使用期間或永遠（依模式而定） | 依模式為前景／背景位置     | 位置權限                 | `LOCATION_PERMISSION_REQUIRED` |
| `system.run`                 | 不適用（節點主機路徑）       | 不適用（節點主機路徑）     | 需要 Exec 核准           | `SYSTEM_RUN_DENIED`            |

## 配對與核准的差異

這是不同的關卡：

1. **裝置配對**：此節點是否能連線至 Gateway 閘道器？
2. **Exec 核准**：此節點是否能執行特定的 Shell 指令？

快速檢查：

```bash
openclaw devices list
openclaw nodes status
openclaw approvals get --node <idOrNameOrIp>
openclaw approvals allowlist add --node <idOrNameOrIp> "/usr/bin/uname"
```

如果缺少配對，請先核准節點裝置。
若配對正常但 `system.run` 失敗，請修正 exec 核准／允許清單。

## 常見節點錯誤代碼

- `NODE_BACKGROUND_UNAVAILABLE` → App 在背景；請切換到前景。
- `CAMERA_DISABLED` → 節點設定中停用了相機切換。
- `*_PERMISSION_REQUIRED` → 缺少／被拒絕的 OS 權限。
- `LOCATION_DISABLED` → 位置模式已關閉。
- `LOCATION_PERMISSION_REQUIRED` → 未授與請求的位置模式。
- `LOCATION_BACKGROUND_UNAVAILABLE` → App 在背景，但僅有「使用期間」權限。
- `SYSTEM_RUN_DENIED: approval required` → Exec 請求需要明確核准。
- `SYSTEM_RUN_DENIED: allowlist miss` → 指令被允許清單模式阻擋。

## 快速復原流程

```bash
openclaw nodes status
openclaw nodes describe --node <idOrNameOrIp>
openclaw approvals get --node <idOrNameOrIp>
openclaw logs --follow
```

若仍卡住：

- 重新核准裝置配對。
- 重新開啟節點 App（切換到前景）。
- 重新授與 OS 權限。
- 重新建立／調整 exec 核准政策。

相關內容：

- [/nodes/index](/nodes/index)
- [/nodes/camera](/nodes/camera)
- [/nodes/location-command](/nodes/location-command)
- [/tools/exec-approvals](/tools/exec-approvals)
- [/gateway/pairing](/gateway/pairing)
