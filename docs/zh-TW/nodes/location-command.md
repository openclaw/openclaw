---
summary: >-
  Location command for nodes (location.get), permission modes, and Android
  foreground behavior
read_when:
  - Adding location node support or permissions UI
  - Designing Android location permissions or foreground behavior
title: Location Command
---

# 位置指令（節點）

## 簡要說明

- `location.get` 是一個節點指令（透過 `node.invoke`）。
- 預設為關閉。
- Android 應用設定使用選擇器：關閉 / 使用中。
- 獨立切換：精確位置。

## 為什麼使用選擇器（而非單純開關）

作業系統權限是多層級的。我們可以在應用內提供選擇器，但實際授權仍由作業系統決定。

- iOS/macOS 可能在系統提示或設定中顯示「使用中」或「永遠」。
- Android 應用目前只支援前景位置權限。
- 精確位置是獨立授權（iOS 14+ 的「精確」，Android 的「精細」與「粗略」之分）。

UI 中的選擇器決定我們請求的模式；實際授權則存在於作業系統設定中。

## 設定模型

每個節點裝置：

- `location.enabledMode`：`off | whileUsing`
- `location.preciseEnabled`：布林值

UI 行為：

- 選擇 `whileUsing` 會請求前景權限。
- 若作業系統拒絕請求的權限等級，則回復至最高已授權等級並顯示狀態。

## 權限對應（node.permissions）

選用。macOS 節點會透過權限映射回報 `location`；iOS/Android 可能省略。

## 指令：`location.get`

透過 `node.invoke` 呼叫。

建議參數：

```json
{
  "timeoutMs": 10000,
  "maxAgeMs": 15000,
  "desiredAccuracy": "coarse|balanced|precise"
}
```

回應內容：

```json
{
  "lat": 48.20849,
  "lon": 16.37208,
  "accuracyMeters": 12.5,
  "altitudeMeters": 182.0,
  "speedMps": 0.0,
  "headingDeg": 270.0,
  "timestamp": "2026-01-03T12:34:56.000Z",
  "isPrecise": true,
  "source": "gps|wifi|cell|unknown"
}
```

錯誤（穩定程式碼）：

- `LOCATION_DISABLED`：選擇器已關閉。
- `LOCATION_PERMISSION_REQUIRED`：缺少請求模式的權限。
- `LOCATION_BACKGROUND_UNAVAILABLE`：應用程式在背景執行，但僅允許「使用中」模式。
- `LOCATION_TIMEOUT`：無法及時取得定位。
- `LOCATION_UNAVAILABLE`：系統故障／無提供者。

## 背景行為

- Android 應用在背景時會拒絕 `location.get`。
- 在 Android 上請求定位時，保持 OpenClaw 開啟。
- 其他節點平台可能有所不同。

## 模型／工具整合

- 工具介面：`nodes` 工具新增 `location_get` 動作（需節點）。
- CLI：`openclaw nodes location get --node <id>`。
- 代理指引：僅在使用者啟用定位且了解範圍時呼叫。

## 使用者體驗文案（建議）

- 關閉：「位置分享已停用。」
- 使用中：「僅在 OpenClaw 開啟時。」
- 精確：「使用精確 GPS 位置。關閉以分享大約位置。」
