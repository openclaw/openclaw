---
summary: >-
  Troubleshoot WSL2 Gateway + Windows Chrome remote CDP and extension-relay
  setups in layers
read_when:
  - Running OpenClaw Gateway in WSL2 while Chrome lives on Windows
  - Seeing overlapping browser/control-ui errors across WSL2 and Windows
  - >-
    Deciding between raw remote CDP and the Chrome extension relay in split-host
    setups
title: WSL2 + Windows + remote Chrome CDP troubleshooting
---

# WSL2 + Windows + 遠端 Chrome CDP 疑難排解

本指南涵蓋常見的跨主機設定，其中：

- OpenClaw Gateway 執行於 WSL2 內
- Chrome 執行於 Windows
- 瀏覽器控制必須跨越 WSL2/Windows 邊界

同時也涵蓋了來自 [issue #39369](https://github.com/openclaw/openclaw/issues/39369) 的多層失效模式：多個獨立問題可能同時出現，導致錯誤的層級先看起來壞掉。

## 先選擇正確的瀏覽器模式

你有兩種有效的模式：

### 選項 1：純遠端 CDP

使用遠端瀏覽器設定檔，從 WSL2 指向 Windows Chrome 的 CDP 端點。

適用於：

- 你只需要瀏覽器控制功能
- 你能接受將 Chrome 遠端除錯暴露給 WSL2
- 你不需要 Chrome 擴充功能中繼

### 選項 2：Chrome 擴充功能中繼

使用內建的 `chrome` 設定檔搭配 OpenClaw Chrome 擴充功能。

適用於：

- 你想用工具列按鈕附加到現有的 Windows Chrome 分頁
- 你想要基於擴充功能的控制，而非純 `--remote-debugging-port`
- 中繼本身必須能跨越 WSL2/Windows 邊界被存取

如果你跨命名空間使用擴充功能中繼，`browser.relayBindHost` 是在 [Browser](/tools/browser) 和 [Chrome extension](/tools/chrome-extension) 中引入的重要設定。

## 運作架構

參考架構：

- WSL2 在 `127.0.0.1:18789` 上執行 Gateway
- Windows 在 `http://127.0.0.1:18789/` 以一般瀏覽器開啟 Control UI
- Windows Chrome 在 `9222` 埠口開放 CDP 端點
- WSL2 可以連到該 Windows CDP 端點
- OpenClaw 將瀏覽器設定指向 WSL2 可連的地址

## 為什麼這個設定容易混淆

可能會有多重錯誤同時發生：

- WSL2 無法連到 Windows CDP 端點
- Control UI 是從非安全來源開啟
- `gateway.controlUi.allowedOrigins` 與頁面來源不符
- token 或配對資訊遺失
- 瀏覽器設定指向錯誤的地址
- 擴充功能中繼仍只限於 loopback，實際上需要跨命名空間存取

因此，修正其中一層錯誤後，仍可能看到其他錯誤訊息。

## Control UI 的關鍵規則

當 UI 從 Windows 開啟時，除非有特別設定 HTTPS，否則請使用 Windows localhost。

使用：

`http://127.0.0.1:18789/`

不要預設使用 LAN IP 來開啟 Control UI。在 LAN 或 tailnet 位址上使用純 HTTP 可能會觸發與 CDP 無關的非安全來源或裝置驗證行為。詳見 [Control UI](/web/control-ui)。

## 分層驗證

由上而下檢查，勿跳過步驟。

### 第一層：確認 Chrome 在 Windows 上有提供 CDP

在 Windows 上啟動 Chrome 並啟用遠端除錯功能：

```powershell
chrome.exe --remote-debugging-port=9222
```

先在 Windows 上確認 Chrome 本身是否正常：

```powershell
curl http://127.0.0.1:9222/json/version
curl http://127.0.0.1:9222/json/list
```

如果在 Windows 上失敗，表示 OpenClaw 尚未出問題。

### 第二層：確認 WSL2 能連到該 Windows 端點

在 WSL2 中，測試你打算在 `cdpUrl` 使用的確切位址：

```bash
curl http://WINDOWS_HOST_OR_IP:9222/json/version
curl http://WINDOWS_HOST_OR_IP:9222/json/list
```

理想結果：

- `/json/version` 回傳包含瀏覽器 / 協議版本資訊的 JSON
- `/json/list` 回傳 JSON（如果沒有開啟頁面，空陣列也沒問題）

如果失敗：

- Windows 尚未將該埠口開放給 WSL2
- WSL2 端使用的位址錯誤
- 防火牆 / 埠口轉發 / 本地代理設定尚未完成

請先解決這些問題，再調整 OpenClaw 設定。

### 第三層：設定正確的瀏覽器設定檔

對於純遠端 CDP，請將 OpenClaw 指向 WSL2 可連線的位址：

```json5
{
  browser: {
    enabled: true,
    defaultProfile: "remote",
    profiles: {
      remote: {
        cdpUrl: "http://WINDOWS_HOST_OR_IP:9222",
        attachOnly: true,
        color: "#00AA00",
      },
    },
  },
}
```

注意事項：

- 使用 WSL2 可連線的地址，而非僅在 Windows 上可用的地址
- 對於外部管理的瀏覽器，請保留 `attachOnly: true`
- 在期望 OpenClaw 成功之前，先用 `curl` 測試相同的 URL

### 第四層：如果你改用 Chrome 擴充功能中繼

如果瀏覽器機器與 Gateway 被命名空間邊界隔開，中繼可能需要非迴圈回路的綁定地址。

範例：

```json5
{
  browser: {
    enabled: true,
    defaultProfile: "chrome",
    relayBindHost: "0.0.0.0",
  },
}
```

僅在必要時使用：

- 預設行為較安全，因為中繼只綁定在迴圈回路地址
- `0.0.0.0` 會擴大暴露面
- 請保持 Gateway 認證、節點配對及周邊網路的私密性

如果不需要擴充功能中繼，建議優先使用上述的原始遠端 CDP 設定。

### 第五層：分別驗證控制介面層

從 Windows 開啟 UI：

`http://127.0.0.1:18789/`

接著確認：

- 頁面來源符合 `gateway.controlUi.allowedOrigins` 的預期
- token 認證或配對設定正確
- 你不是在將控制介面認證問題誤當成瀏覽器問題來除錯

有用的頁面：

- [控制介面](/web/control-ui)

### 第6層：驗證端對端瀏覽器控制

從 WSL2：

```bash
openclaw browser open https://example.com --browser-profile remote
openclaw browser tabs --browser-profile remote
```

針對擴充功能中繼：

```bash
openclaw browser tabs --browser-profile chrome
```

良好結果：

- 分頁會在 Windows Chrome 中開啟
- `openclaw browser tabs` 回傳目標
- 後續動作 (`snapshot`, `screenshot`, `navigate`) 會使用相同的設定檔執行

## 常見誤導錯誤

將每則訊息視為特定層級的線索：

- `control-ui-insecure-auth`
  - UI 來源 / 安全上下文問題，非 CDP 傳輸問題
- `token_missing`
  - 認證設定問題
- `pairing required`
  - 裝置授權問題
- `Remote CDP for profile "remote" is not reachable`
  - WSL2 無法連接設定的 `cdpUrl`
- `gateway timeout after 1500ms`
  - 通常仍是 CDP 可達性問題或遠端端點回應慢/無法連線
- `Chrome extension relay is running, but no tab is connected`
  - 選擇了擴充功能中繼設定檔，但尚未有附加的分頁存在

## 快速排查清單

1. Windows：`curl http://127.0.0.1:9222/json/version` 是否正常運作？
2. WSL2：`curl http://WINDOWS_HOST_OR_IP:9222/json/version` 是否正常運作？
3. OpenClaw 設定：`browser.profiles.<name>.cdpUrl` 是否使用該可由 WSL2 連線的正確位址？
4. 控制介面：你是否開啟了 `http://127.0.0.1:18789/` 而非 LAN IP？
5. 僅限擴充功能中繼：你是否真的需要 `browser.relayBindHost`，若需要，是否有明確設定？

## 實務重點

設定通常是可行的。困難之處在於瀏覽器傳輸、Control UI 的來源安全性、token/配對，以及擴充功能中繼拓撲，這些都可能各自獨立失敗，但從使用者端看起來卻很相似。[[BLOCK_1]]

有疑慮時：[[BLOCK_2]]

- 先在本機驗證 Windows Chrome 端點
- 再從 WSL2 驗證相同端點
- 然後才除錯 OpenClaw 設定或 Control UI 認證[[BLOCK_3]]
