---
summary: "智慧代理使用的相機擷取（iOS 節點 + macOS 應用程式）：相片 (jpg) 與短片 (mp4)"
read_when:
  - 在 iOS 節點或 macOS 上新增或修改相機擷取功能時
  - 擴充智慧代理可存取的 MEDIA 暫存檔案工作流程時
title: "相機擷取"
---

# 相機擷取 (智慧代理)

OpenClaw 支援智慧代理工作流程中的**相機擷取**：

- **iOS 節點**（透過 Gateway 配對）：透過 `node.invoke` 擷取**相片** (`jpg`) 或**短片** (`mp4`，可選音訊)。
- **Android 節點**（透過 Gateway 配對）：透過 `node.invoke` 擷取**相片** (`jpg`) 或**短片** (`mp4`，可選音訊)。
- **macOS 應用程式**（透過 Gateway 的節點）：透過 `node.invoke` 擷取**相片** (`jpg`) 或**短片** (`mp4`，可選音訊)。

所有相機存取都受到**使用者控制設定**的限制。

## iOS 節點

### 使用者設定（預設開啟）

- iOS 設定分頁 → **相機** → **允許相機** (`camera.enabled`)
  - 預設：**開啟**（遺失鍵名時視為已啟用）。
  - 關閉時：`camera.*` 指令會回傳 `CAMERA_DISABLED`。

### 指令（透過 Gateway `node.invoke`）

- `camera.list`
  - 回應內容：
    - `devices`: `{ id, name, position, deviceType }` 的陣列

- `camera.snap`
  - 參數：
    - `facing`: `front|back`（預設：`front`）
    - `maxWidth`: 數字（選填；iOS 節點預設為 `1600`）
    - `quality`: `0..1`（選填；預設為 `0.9`）
    - `format`: 目前為 `jpg`
    - `delayMs`: 數字（選填；預設為 `0`）
    - `deviceId`: 字串（選填；來自 `camera.list`）
  - 回應內容：
    - `format: "jpg"`
    - `base64: "<...>"`
    - `width`, `height`
  - 內容防護：相片會重新壓縮，以確保 base64 內容維持在 5 MB 以下。

- `camera.clip`
  - 參數：
    - `facing`: `front|back`（預設：`front`）
    - `durationMs`: 數字（預設為 `3000`，上限為 `60000`）
    - `includeAudio`: 布林值（預設為 `true`）
    - `format`: 目前為 `mp4`
    - `deviceId`: 字串（選填；來自 `camera.list`）
  - 回應內容：
    - `format: "mp4"`
    - `base64: "<...>"`
    - `durationMs`
    - `hasAudio`

### 前台需求

與 `canvas.*` 類似，iOS 節點僅允許在**前台**執行 `camera.*` 指令。在背景呼叫會回傳 `NODE_BACKGROUND_UNAVAILABLE`。

### CLI 輔助工具（暫存檔案 + MEDIA）

取得附件最簡單的方法是透過 CLI 輔助工具，它會將解碼後的媒體寫入暫存檔案並列印 `MEDIA:<path>`。

範例：

```bash
openclaw nodes camera snap --node <id>               # 預設：同時開啟前後鏡頭（產生 2 行 MEDIA）
openclaw nodes camera snap --node <id> --facing front
openclaw nodes camera clip --node <id> --duration 3000
openclaw nodes camera clip --node <id> --no-audio
```

附註：

- `nodes camera snap` 預設為**兩者**鏡頭，以便為智慧代理提供兩種視角。
- 除非您建立自己的包裝程式，否則輸出檔案是暫存的（位於作業系統的暫存目錄中）。

## Android 節點

### Android 使用者設定（預設開啟）

- Android 設定面板 → **相機** → **允許相機** (`camera.enabled`)
  - 預設：**開啟**（遺失鍵名時視為已啟用）。
  - 關閉時：`camera.*` 指令會回傳 `CAMERA_DISABLED`。

### 權限

- Android 需要執行階段權限：
  - `camera.snap` 與 `camera.clip` 均需 `CAMERA`。
  - 當 `includeAudio=true` 時，`camera.clip` 需 `RECORD_AUDIO`。

如果缺少權限，應用程式會在可能的情況下發出提示；如果被拒絕，`camera.*` 請求將失敗並顯示 `*_PERMISSION_REQUIRED` 錯誤。

### Android 前台需求

與 `canvas.*` 類似，Android 節點僅允許在**前台**執行 `camera.*` 指令。在背景呼叫會回傳 `NODE_BACKGROUND_UNAVAILABLE`。

### 內容防護

相片會重新壓縮，以確保 base64 內容維持在 5 MB 以下。

## macOS 應用程式

### 使用者設定（預設關閉）

macOS 配套應用提供了一個核取方塊：

- **設定 → 一般 → 允許相機** (`openclaw.cameraEnabled`)
  - 預設：**關閉**
  - 關閉時：相機請求會回傳 “Camera disabled by user”。

### CLI 輔助工具 (node invoke)

使用主 `openclaw` CLI 在 macOS 節點上呼叫相機指令。

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

附註：

- 除非覆寫，否則 `openclaw nodes camera snap` 預設為 `maxWidth=1600`。
- 在 macOS 上，`camera.snap` 在啟動/曝光穩定後會等待 `delayMs`（預設 2000ms）再進行擷取。
- 相片內容會重新壓縮，以確保 base64 維持在 5 MB 以下。

## 安全性 + 實際限制

- 相機與麥克風存取會觸發一般的作業系統權限提示（且需要在 Info.plist 中包含使用說明字串）。
- 影片短片受到限制（目前為 `<= 60s`），以避免節點內容過大（base64 開銷 + 訊息限制）。

## macOS 螢幕影片 (作業系統層級)

若要錄製*螢幕*影片（而非相機），請使用 macOS 配套應用：

```bash
openclaw nodes screen record --node <id> --duration 10s --fps 15   # 列印 MEDIA:<path>
```

附註：

- 需要 macOS **螢幕錄製**權限 (TCC)。
