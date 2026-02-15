---
summary: "OpenClaw 在 macOS 上的選單列圖示狀態與動畫"
read_when:
  - 更改選單列圖示行為時
title: "選單列圖示"
---

# 選單列圖示狀態

作者: steipete · 更新日期: 2025-12-06 · 範圍: macOS 應用程式 (`apps/macos`)

- **閒置:** 正常圖示動畫 (閃爍、偶爾擺動)。
- **暫停:** 狀態項目使用 `appearsDisabled`；無任何動作。
- **語音觸發 (大耳朵):** 當聽到喚醒詞時，語音喚醒偵測器會呼叫 `AppState.triggerVoiceEars(ttl: nil)`，並在捕捉到語音時保持 `earBoostActive=true`。耳朵會放大 (1.9 倍)，為了可讀性會出現圓形耳洞，然後在靜音 1 秒後透過 `stopVoiceEars()` 縮回。僅從應用程式內的語音管線觸發。
- **工作中 (智慧代理執行中):** `AppState.isWorking=true` 會驅動「尾巴/腿部快速移動」的微動作：在工作進行中時，腿部擺動更快，並略微偏移。目前在 WebChat 智慧代理執行期間切換；在連接其他長時間任務時，也要加入相同的切換。

連接點

- 語音喚醒: 執行時/測試器在觸發時呼叫 `AppState.triggerVoiceEars(ttl: nil)`，並在靜音 1 秒後呼叫 `stopVoiceEars()`，以符合捕捉視窗。
- 智慧代理活動: 在工作範圍前後設定 `AppStateStore.shared.setWorking(true/false)` (已在 WebChat 智慧代理呼叫中完成)。保持工作範圍簡短，並在 `defer` 區塊中重設，以避免動畫卡住。

形狀與尺寸

- 基本圖示繪製於 `CritterIconRenderer.makeIcon(blink:legWiggle:earWiggle:earScale:earHoles:)` 中。
- 耳朵比例預設為 `1.0`；語音增強會將 `earScale=1.9` 並切換 `earHoles=true`，而不改變整體框架 (18×18 點的模板圖像會渲染到 36×36 像素的 Retina 備用儲存中)。
- 快速移動會使腿部擺動高達約 1.0，並帶有輕微的水平抖動；它是對任何現有閒置擺動的疊加。

行為注意事項

- 耳朵/工作沒有外部 CLI/代理切換；將其保留在應用程式自己的信號內部，以避免意外閃爍。
- 保持 TTL 較短 (<10s)，這樣如果任務掛起，圖示會迅速恢復到基準狀態。
