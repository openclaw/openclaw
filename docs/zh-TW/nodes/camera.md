---
summary: "供代理程式使用的相機擷取（iOS 節點 + macOS 應用程式）：照片（jpg）與短影片剪輯（mp4）"
read_when:
  - 新增或修改 iOS 節點或 macOS 上的相機擷取功能時
  - 擴充代理程式可存取的 MEDIA 暫存檔案工作流程時
title: "相機擷取"
---

# 相機擷取（代理程式）

OpenClaw 支援用於代理程式工作流程的 **相機擷取**：

- **iOS 節點**（透過 Gateway 閘道器 配對）：透過 `node.invoke` 擷取 **照片**（`jpg`）或 **短影片剪輯**（`mp4`，可選擇是否包含音訊）。
- **Android 節點**（透過 Gateway 閘道器 配對）：透過 `node.invoke` 擷取 **照片**（`jpg`）或 **短影片剪輯**（`mp4`，可選擇是否包含音訊）。
- **macOS 應用程式**（作為透過 Gateway 閘道器 的節點）：透過 `node.invoke` 擷取 **照片**（`jpg`）或 **短影片剪輯**（`mp4`，可選擇是否包含音訊）。

所有相機存取皆受到 **使用者可控制的設定** 所限制。

## iOS 節點

### 使用者設定（預設開啟）

- iOS 設定分頁 → **Camera** → **Allow Camera**（`camera.enabled`）
  - 32. 預設：**開啟**（缺少鍵視為已啟用）。
  - 關閉時：`camera.*` 指令會回傳 `CAMERA_DISABLED`。

### 指令（透過 Gateway `node.invoke`）

- `camera.list`
  - 回應負載：
    - `devices`：`{ id, name, position, deviceType }` 的陣列

- `camera.snap`
  - Params:
    - `facing`：`front|back`（預設：`front`）
    - `maxWidth`：number（選用；iOS 節點上的預設為 `1600`）
    - `quality`：`0..1`（選用；預設：`0.9`）
    - `format`：目前為 `jpg`
    - `delayMs`：number（選用；預設：`0`）
    - `deviceId`：string（選用；來自 `camera.list`）
  - 回應負載：
    - `format: "jpg"`
    - `base64: "<...>"`
    - `width`、`height`
  - 負載防護：照片會重新壓縮，以確保 base64 負載低於 5 MB。

- `camera.clip`
  - Params:
    - `facing`：`front|back`（預設：`front`）
    - `durationMs`：number（預設 `3000`，並限制最大值為 `60000`）
    - `includeAudio`：boolean（預設 `true`）
    - `format`：目前為 `mp4`
    - `deviceId`：string（選用；來自 `camera.list`）
  - 回應負載：
    - `format: "mp4"`
    - `base64: "<...>"`
    - `durationMs`
    - `hasAudio`

### 前景需求

如同 `canvas.*`，iOS 節點僅允許在 **前景** 執行 `camera.*` 指令。於背景呼叫時會回傳 `NODE_BACKGROUND_UNAVAILABLE`。 Background invocations return `NODE_BACKGROUND_UNAVAILABLE`.

### CLI 輔助工具（暫存檔案 + MEDIA）

取得附件最簡單的方式是使用 CLI 輔助工具，它會將解碼後的媒體寫入暫存檔案，並輸出 `MEDIA:<path>`。

範例：

```bash
openclaw nodes camera snap --node <id>               # default: both front + back (2 MEDIA lines)
openclaw nodes camera snap --node <id> --facing front
openclaw nodes camera clip --node <id> --duration 3000
openclaw nodes camera clip --node <id> --no-audio
```

注意事項：

- `nodes camera snap` 預設為 **兩者皆有** 的鏡頭方向，以提供代理程式兩種視角。
- 50. 輸出檔案為暫存檔（位於作業系統的暫存目錄），除非你自行建立包裝器。

## Android 節點

### Android 使用者設定（預設開啟）

- Android 設定頁面 → **Camera** → **Allow Camera**（`camera.enabled`）
  - 預設值：**on**（缺少鍵值時視為已啟用）。
  - 關閉時：`camera.*` 指令會回傳 `CAMERA_DISABLED`。

### 權限

- Android 需要執行階段權限：
  - `CAMERA`，用於 `camera.snap` 與 `camera.clip`。
  - 當 `includeAudio=true` 時，`RECORD_AUDIO` 用於 `camera.clip`。

若缺少權限，應用程式會在可能時提示；若遭拒絕，`camera.*` 請求將以
`*_PERMISSION_REQUIRED` 錯誤失敗。

### Android 前景需求

如同 `canvas.*`，Android 節點僅允許在 **前景** 執行 `camera.*` 指令。於背景呼叫時會回傳 `NODE_BACKGROUND_UNAVAILABLE`。 背景呼叫會回傳 `NODE_BACKGROUND_UNAVAILABLE`。

### Payload 防護

照片會重新壓縮，以確保 base64 負載低於 5 MB。

## macOS 應用程式

### 使用者設定（預設關閉）

macOS 伴隨應用程式提供一個核取方塊：

- **Settings → General → Allow Camera**（`openclaw.cameraEnabled`）
  - 預設：**關閉**
  - 關閉時：相機請求會回傳「Camera disabled by user」。

### CLI 輔助工具（節點呼叫）

使用主要的 `openclaw` CLI，在 macOS 節點上呼叫相機指令。

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

- `openclaw nodes camera snap` 預設為 `maxWidth=1600`，除非另行覆寫。
- 在 macOS 上，`camera.snap` 會在暖機／曝光穩定後等待 `delayMs`（預設 2000ms）再進行擷取。
- 照片負載會重新壓縮，以確保 base64 低於 5 MB。

## 安全性與實務限制

- 相機與麥克風存取會觸發一般的作業系統權限提示（並且需要在 Info.plist 中提供使用說明字串）。
- 為避免節點負載過大（base64 額外負擔 + 訊息限制），影片剪輯有上限（目前為 `<= 60s`）。

## macOS 螢幕影片（作業系統層級）

若要錄製「螢幕」影片（非相機），請使用 macOS 配套應用程式：

```bash
openclaw nodes screen record --node <id> --duration 10s --fps 15   # prints MEDIA:<path>
```

注意事項：

- 需要 macOS **Screen Recording** 權限（TCC）。
