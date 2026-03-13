---
summary: >-
  Camera capture (iOS/Android nodes + macOS app) for agent use: photos (jpg) and
  short video clips (mp4)
read_when:
  - Adding or modifying camera capture on iOS/Android nodes or macOS
  - Extending agent-accessible MEDIA temp-file workflows
title: Camera Capture
---

# 相機擷取（代理）

OpenClaw 支援代理工作流程中的 **相機擷取**：

- **iOS 節點**（透過 Gateway 配對）：透過 `node.invoke` 擷取 **照片** (`jpg`) 或 **短影片片段** (`mp4`，可選擇包含音訊）。
- **Android 節點**（透過 Gateway 配對）：透過 `node.invoke` 擷取 **照片** (`jpg`) 或 **短影片片段** (`mp4`，可選擇包含音訊）。
- **macOS 應用程式**（透過 Gateway 的節點）：透過 `node.invoke` 擷取 **照片** (`jpg`) 或 **短影片片段** (`mp4`，可選擇包含音訊）。

所有相機存取均受 **使用者控制設定** 限制。

## iOS 節點

### 使用者設定（預設開啟）

- iOS 設定頁籤 → **相機** → **允許相機** (`camera.enabled`)
  - 預設：**開啟**（缺少此設定視為已啟用）。
  - 關閉時：`camera.*` 指令會回傳 `CAMERA_DISABLED`。

### 指令（透過 Gateway `node.invoke`）

- `camera.list`
  - 回應內容：
    - `devices`：`{ id, name, position, deviceType }` 陣列

- `camera.snap`
  - 參數：
    - `facing`：`front|back`（預設：`front`）
    - `maxWidth`：數字（可選；iOS 節點預設 `1600`）
    - `quality`：`0..1`（可選；預設 `0.9`）
    - `format`：目前為 `jpg`
    - `delayMs`：數字（可選；預設 `0`）
    - `deviceId`：字串（可選；來源自 `camera.list`）
  - 回應內容：
    - `format: "jpg"`
    - `base64: "<...>"`
    - `width`、`height`
  - 內容限制：照片會重新壓縮，以保持 base64 內容小於 5 MB。

- `camera.clip`
  - 參數：
    - `facing`：`front|back`（預設：`front`）
    - `durationMs`：數字（預設 `3000`，最大限制為 `60000`）
    - `includeAudio`：布林值（預設 `true`）
    - `format`：目前為 `mp4`
    - `deviceId`：字串（可選；來源自 `camera.list`）
  - 回應內容：
    - `format: "mp4"`
    - `base64: "<...>"`
    - `durationMs`
    - `hasAudio`

### 前景需求

如同 `canvas.*`，iOS 節點僅允許在 **前景** 執行 `camera.*` 指令。背景執行會回傳 `NODE_BACKGROUND_UNAVAILABLE`。

### CLI 輔助工具（暫存檔案 + MEDIA）

取得附件最簡單的方式是使用 CLI 輔助工具，它會將解碼後的媒體寫入暫存檔案，並列印 `MEDIA:<path>`。

範例：

```bash
openclaw nodes camera snap --node <id>               # default: both front + back (2 MEDIA lines)
openclaw nodes camera snap --node <id> --facing front
openclaw nodes camera clip --node <id> --duration 3000
openclaw nodes camera clip --node <id> --no-audio
```

說明：

- `nodes camera snap` 預設為 **雙面**，讓代理同時取得兩個視角。
- 輸出檔案為暫存檔（位於作業系統的暫存目錄），除非你自行建立包裝器。

## Android 節點

### Android 使用者設定（預設開啟）

- Android 設定頁 → **相機** → **允許相機** (`camera.enabled`)
  - 預設：**開啟**（缺少此設定視為已啟用）。
  - 關閉時：`camera.*` 指令會回傳 `CAMERA_DISABLED`。

### 權限

- Android 需要執行時權限：
  - `CAMERA` 用於 `camera.snap` 和 `camera.clip`。
  - `RECORD_AUDIO` 用於 `camera.clip`，當 `includeAudio=true` 時。

若缺少權限，App 會在可能時提示；若被拒絕，`camera.*` 請求會失敗並回傳 `*_PERMISSION_REQUIRED` 錯誤。

### Android 前景需求

如同 `canvas.*`，Android 節點僅允許在 **前景** 執行 `camera.*` 指令。背景執行會回傳 `NODE_BACKGROUND_UNAVAILABLE`。

### Android 指令（透過 Gateway `node.invoke`）

- `camera.list`
  - 回應內容：
    - `devices`：`{ id, name, position, deviceType }` 陣列

### 載荷防護

照片會重新壓縮，以保持 base64 負載低於 5 MB。

## macOS 應用程式

### 使用者設定（預設關閉）

macOS 伴隨應用程式提供一個勾選框：

- **設定 → 一般 → 允許相機** (`openclaw.cameraEnabled`)
  - 預設：**關閉**
  - 關閉時：相機請求會回傳「使用者已停用相機」。

### CLI 輔助工具（node invoke）

使用主要的 `openclaw` CLI 來在 macOS 節點上呼叫相機指令。

範例：

```bash
openclaw nodes camera list --node <id>            # list camera ids
openclaw nodes camera snap --node <id>            # prints MEDIA:<path>
openclaw nodes camera snap --node <id> --max-width 1280
openclaw nodes camera snap --node <id> --delay-ms 2000
openclaw nodes camera snap --node <id> --device-id <id>
openclaw nodes camera clip --node <id> --duration 10s          # prints MEDIA:<path>
openclaw nodes camera clip --node <id> --duration-ms 3000      # prints MEDIA:<path> (legacy flag)
openclaw nodes camera clip --node <id> --device-id <id>
openclaw nodes camera clip --node <id> --no-audio
```

注意事項：

- `openclaw nodes camera snap` 預設為 `maxWidth=1600`，除非被覆寫。
- 在 macOS 上，`camera.snap` 會在預熱／曝光穩定後等待 `delayMs`（預設 2000 毫秒）才進行拍攝。
- 照片負載會重新壓縮，以保持 base64 低於 5 MB。

## 安全性與實務限制

- 相機和麥克風存取會觸發作業系統的權限提示（並且 Info.plist 需包含使用說明字串）。
- 影片片段有上限（目前為 `<= 60s`），以避免節點負載過大（base64 開銷加上訊息限制）。

## macOS 螢幕錄影（作業系統層級）

若為 _螢幕_ 錄影（非相機），請使用 macOS 伴隨應用程式：

```bash
openclaw nodes screen record --node <id> --duration 10s --fps 15   # prints MEDIA:<path>
```

注意：

- 需要 macOS **螢幕錄製** 權限（TCC）。
