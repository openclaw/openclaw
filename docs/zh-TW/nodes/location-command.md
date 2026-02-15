---
summary: "節點的位置指令 (location.get)、權限模式與背景行為"
read_when:
  - 新增位置節點支援或權限 UI 時
  - 設計背景位置 + 推播流程時
title: "位置指令"
---

# 位置指令 (節點)

## 摘要

- `location.get` 是一個節點指令（透過 `node.invoke` 呼叫）。
- 預設為關閉。
- 設定中使用選擇器：關閉 / 使用中 / 始終。
- 獨立開關：精確位置。

## 為什麼使用選擇器（而不只是開關）

作業系統權限是多層級的。我們可以在應用程式內提供選擇器，但實際的授權仍由作業系統決定。

- iOS/macOS：使用者可以在系統提示或「設定」中選擇**使用中**或**始終**。應用程式可以請求升級權限，但作業系統可能會要求使用者前往「設定」手動更改。
- Android：背景位置是獨立的權限；在 Android 10 以上版本，通常需要透過「設定」流程來開啟。
- 精確位置是獨立的授權（iOS 14+ 的「精確」，Android 的「精確 (fine)」對比「概略 (coarse)」）。

UI 中的選擇器驅動我們請求的模式；實際的授權狀態則存在於作業系統設定中。

## 設定模型

每個節點裝置：

- `location.enabledMode`: `off | whileUsing | always`
- `location.preciseEnabled`: bool

UI 行為：

- 選擇 `whileUsing` 會請求前台權限。
- 選擇 `always` 會先確保已取得 `whileUsing` 權限，接著請求背景權限（如有必要，引導使用者前往「設定」）。
- 如果作業系統拒絕了請求的層級，則退回至已授權的最高等級並顯示狀態。

## 權限映射 (node.permissions)

選填。macOS 節點透過權限映射回報 `location`；iOS/Android 則可能省略。

## 指令：`location.get`

透過 `node.invoke` 呼叫。

參數（建議）：

```json
{
  "timeoutMs": 10000,
  "maxAgeMs": 15000,
  "desiredAccuracy": "coarse|balanced|precise"
}
```

回應酬載：

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

錯誤（穩定錯誤碼）：

- `LOCATION_DISABLED`：選擇器為關閉狀態。
- `LOCATION_PERMISSION_REQUIRED`：缺少所請求模式的權限。
- `LOCATION_BACKGROUND_UNAVAILABLE`：應用程式處於背景，但僅允許「使用中」權限。
- `LOCATION_TIMEOUT`：在時間內無法取得定位。
- `LOCATION_UNAVAILABLE`：系統故障 / 無法取得供應商資訊。

## 背景行為（未來規劃）

目標：即使節點處於背景，模型仍可請求位置，但僅限於以下情況：

- 使用者選擇了**始終**。
- 作業系統授予背景位置權限。
- 應用程式被允許在背景執行位置服務（iOS 背景模式 / Android 前台服務或特殊許可）。

推播觸發流程（未來規劃）：

1. Gateway 向節點發送推播（靜默推播或 FCM 資料）。
2. 節點短暫喚醒並向裝置請求位置。
3. 節點將酬載轉發至 Gateway。

注意事項：

- iOS：需要「始終」授權與背景位置模式。靜默推播可能會受到節流限制；預期可能會有間歇性失敗。
- Android：背景位置可能需要前台服務；否則預期會被拒絕。

## 模型/工具整合

- 工具層面：`nodes` 工具新增 `location_get` 動作（需要節點 ID）。
- CLI：`openclaw nodes location get --node <id>`。
- 智慧代理指南：僅在使用者啟用位置服務且了解其範圍時才進行呼叫。

## UX 文案（建議）

- 關閉：「位置分享已停用。」
- 使用中：「僅在使用 OpenClaw 期間分享。」
- 始終：「允許背景位置。需要系統權限。」
- 精確：「使用精確 GPS 定位。關閉以分享概略位置。」
