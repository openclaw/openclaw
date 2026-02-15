---
summary: "為智慧代理使用而設的相機擷取（iOS 節點 + macOS 應用程式）：照片 (jpg) 和短影片剪輯 (mp4)"
read_when:
  - 在 iOS 節點或 macOS 上新增或修改相機擷取功能時
  - 擴展智慧代理可存取的 MEDIA 暫存檔案工作流程時
title: "相機擷取"
---

# 相機擷取（智慧代理）

OpenClaw 支援智慧代理工作流程的**相機擷取**：

- **iOS 節點** (透過 Gateway 配對): 透過 `node.invoke` 擷取**照片** (`jpg`) 或**短影片剪輯** (`mp4`，可選音訊)。
- **Android 節點** (透過 Gateway 配對): 透過 `node.invoke` 擷取**照片** (`jpg`) 或**短影片剪輯** (`mp4`，可選音訊)。
- **macOS 應用程式** (透過 Gateway 節點): 透過 `node.invoke` 擷取**照片** (`jpg`) 或**短影片剪輯** (`mp4`，可選音訊)。

所有相機存取都受**使用者控制的設定**限制。

## iOS 節點

### 使用者設定（預設開啟）

- iOS 設定分頁 → **相機** → **允許相機** (`camera.enabled`)
  - 預設: **開啟** (缺少鍵名時視為啟用)。
  - 關閉時: `camera.*` 指令回傳 `CAMERA_DISABLED`。

### 指令（透過 Gateway `node.invoke`）

- `camera.list`
  - 回應酬載：
    - `devices`: `{ id, name, position, deviceType }` 的陣列

- `camera.snap`
  - 參數：
    - `facing`: `front|back` (預設: `front`)
    - `maxWidth`: 數字 (選用; iOS 節點上預設 `1600`)
    - `quality`: `0..1` (選用; 預設 `0.9`)
    - `format`: 目前為 `jpg`
    - `delayMs`: 數字 (選用; 預設 `0`)
    - `deviceId`: 字串 (選用; 來自 `camera.list`)
  - 回應酬載：
    - `format: "jpg"`
    - `base64: "<...>"`
    - `width`, `height`
  - 酬載保護: 照片會重新壓縮，以將 base64 酬載保持在 5 MB 以下。

- `camera.clip`
  - 參數：
    - `facing`: `front|back` (預設: `front`)
    - `durationMs`: 數字 (預設 `3000`，最大限制為 `60000`)
    - `includeAudio`: 布林值 (預設 `true`)
    - `format`: 目前為 `mp4`
    - `deviceId`: 字串 (選用; 來自 `camera.list`)
  - 回應酬載：
    - `format: "mp4"`
    - `base64: "<...>"`
    - `durationMs`
    - `hasAudio`

### 前景要求

與 `canvas.*` 類似，iOS 節點僅允許在前**景**執行 `camera.*` 指令。背景調用會回傳 `NODE_BACKGROUND_UNAVAILABLE`。

### CLI 助手 (暫存檔案 + MEDIA)

取得附件最簡單的方式是透過 CLI 助手，它會將解碼後的媒體寫入暫存檔案並列印 `MEDIA:<path>`。

範例：

```bash
openclaw nodes camera snap --node <id>               # 預設: 前後鏡頭皆會擷取 (2 行 MEDIA)
openclaw nodes camera snap --node <id> --facing front
openclaw nodes camera clip --node <id> --duration 3000
openclaw nodes camera clip --node <id> --no-audio
```

注意事項：

- `nodes camera snap` 預設為**前後鏡頭**皆會擷取，以提供智慧代理兩種視角。
- 輸出檔案是暫存的 (在作業系統的暫存目錄中)，除非您建立自己的封裝程式。

## Android 節點

### Android 使用者設定（預設開啟）

- Android 設定表單 → **相機** → **允許相機** (`camera.enabled`)
  - 預設: **開啟** (缺少鍵名時視為啟用)。
  - 關閉時: `camera.*` 指令回傳 `CAMERA_DISABLED`。

### 權限

- Android 需要執行時權限：
  - `CAMERA` 適用於 `camera.snap` 和 `camera.clip`。
  - `RECORD_AUDIO` 適用於 `camera.clip` 當 `includeAudio=true` 時。

如果缺少權限，應用程式會在可能時提示；如果被拒絕，`camera.*` 請求會因 `*_PERMISSION_REQUIRED` 錯誤而失敗。

### Android 前景要求

與 `canvas.*` 類似，Android 節點僅允許在前**景**執行 `camera.*` 指令。背景調用會回傳 `NODE_BACKGROUND_UNAVAILABLE`。

### 酬載保護

照片會重新壓縮，以將 base64 酬載保持在 5 MB 以下。

## macOS 應用程式

### 使用者設定（預設關閉）

macOS 配套應用程式提供一個核取方塊：

- **設定 → 一般 → 允許相機** (`openclaw.cameraEnabled`)
  - 預設: **關閉**
  - 關閉時: 相機請求回傳「使用者已停用相機」。

### CLI 助手 (節點調用)

使用主要的 `openclaw` CLI 在 macOS 節點上調用相機指令。

範例：

```bash
openclaw nodes camera list --node <id>            # 列出相機 ID
openclaw nodes camera snap --node <id>            # 列印 MEDIA:<path>
openclaw nodes camera snap --node <id> --max-width 1280
openclaw nodes camera snap --node <id> --delay-ms 2000
openclaw nodes camera snap --node <id> --device-id <id>
openclaw nodes camera clip --node <id> --duration 10s          # 列印 MEDIA:<path>
openclaw nodes camera clip --node <id> --duration-ms 3000      # 列印 MEDIA:<path> (舊版旗標)
openclaw nodes camera clip --node <id> --device-id <id>
openclaw nodes camera clip --node <id> --no-audio
```

注意事項：

- `openclaw nodes camera snap` 預設 `maxWidth=1600`，除非被覆寫。
- 在 macOS 上，`camera.snap` 會在暖機/曝光穩定後等待 `delayMs` (預設 2000ms) 才進行擷取。
- 照片酬載會重新壓縮，以將 base64 保持在 5 MB 以下。

## 安全性 + 實際限制

- 相機和麥克風存取會觸發作業系統的權限提示 (並要求 Info.plist 中的使用字串)。
- 影片剪輯有上限 (目前 `<= 60s`)，以避免過大的節點酬載 (base64 開銷 + 訊息限制)。

## macOS 螢幕錄影（作業系統層級）

對於**螢幕**錄影 (而非相機)，請使用 macOS 配套應用程式：

```bash
openclaw nodes screen record --node <id> --duration 10s --fps 15   # 列印 MEDIA:<path>
```

注意事項：

- 需要 macOS **螢幕錄影**權限 (TCC)。
