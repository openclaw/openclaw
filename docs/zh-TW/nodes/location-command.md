---
summary: "節點的位置指令（location.get）、權限模式，以及背景行為"
read_when:
  - 新增位置節點支援或權限 UI
  - 設計背景位置＋推播流程
title: "位置指令"
---

# 位置指令（節點）

## TL;DR

- `location.get` 是一個節點指令（透過 `node.invoke`）。
- 預設為關閉。
- 設定使用選擇器：關閉／使用中／永遠。
- 獨立開關：精確位置。

## 為何使用選擇器（而不只是開關）

作業系統權限是多層級的。 We can expose a selector in-app, but the OS still decides the actual grant.

- iOS/macOS：使用者可在系統提示或「設定」中選擇 **使用中** 或 **永遠**。App 可以請求升級，但 OS 可能要求前往「設定」。 應用程式可以請求升級，但作業系統可能需要透過「設定」。
- Android：背景位置是獨立權限；在 Android 10+ 上通常需要走「設定」流程。
- 精確位置是獨立授權（iOS 14+ 的「精確」，Android 的「fine」對比「coarse」）。

UI 中的選擇器會驅動我們請求的模式；實際授權存在於作業系統設定中。

## 設定模型

每個節點裝置：

- `location.enabledMode`：`off | whileUsing | always`
- `location.preciseEnabled`：bool

UI 行為：

- 選擇 `whileUsing` 會請求前景權限。
- 選擇 `always` 會先確保 `whileUsing`，接著請求背景權限（或在需要時將使用者導向設定）。
- 若 OS 拒絕所請求的層級，回復到已授予的最高層級並顯示狀態。

## 權限對應（node.permissions）

選用。 macOS 節點會透過權限對應表回報 `location`；iOS/Android 可能會省略。

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

錯誤（穩定代碼）：

- `LOCATION_DISABLED`：選擇器為關閉。
- `LOCATION_PERMISSION_REQUIRED`：所請求模式缺少權限。
- `LOCATION_BACKGROUND_UNAVAILABLE`：App 在背景中，但僅允許「使用中」。
- `LOCATION_TIMEOUT`：在時間內未取得定位。
- `LOCATION_UNAVAILABLE`：系統失敗／無提供者。

## 背景行為（未來）

目標：模型即使在節點位於背景時也能請求位置，但僅在以下條件成立時：

- 使用者選擇 **永遠**。
- OS 授予背景位置。
- App 允許為位置在背景中執行（iOS 背景模式／Android 前景服務或特殊許可）。

推播觸發流程（未來）：

1. Gateway 閘道器向節點發送推播（靜默推播或 FCM data）。
2. 節點短暫喚醒並向裝置請求位置。
3. 節點將負載轉送至 Gateway。

注意事項：

- iOS：需要「永遠」權限＋背景位置模式。靜默推播可能被節流；預期會有間歇性失敗。 靜默推播可能會被節流；預期會有間歇性失敗。
- Android：背景位置可能需要前景服務；否則預期會被拒絕。

## 模型／工具整合

- 工具介面：`nodes` 工具新增 `location_get` 動作（需要節點）。
- CLI：`openclaw nodes location get --node <id>`。
- 代理程式指引：僅在使用者已啟用位置且理解範圍時呼叫。

## UX 文案（建議）

- 關閉：「位置分享已停用。」
- 使用中：「僅在 OpenClaw 開啟時。」
- 永遠：「允許背景位置。需要系統權限。」 需要系統權限。”
- 精確：「使用精確 GPS 位置。關閉以分享近似位置。」 關閉切換即可分享大致位置。”
