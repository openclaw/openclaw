---
summary: "OpenClaw 在 macOS 上的選單列圖示狀態與動畫"
read_when:
  - 變更選單列圖示行為時
title: "選單列圖示"
---

# 選單列圖示狀態

作者：steipete · 更新日期：2025-12-06 · 範圍：macOS 應用程式 (`apps/macos`)

- **閒置 (Idle)：** 一般圖示動畫（眨眼、偶爾擺動）。
- **已暫停 (Paused)：** 狀態項目使用 `appearsDisabled`；無動作。
- **語音觸發（大耳朵）：** 當聽到喚醒詞時，語音喚醒偵測器會呼叫 `AppState.triggerVoiceEars(ttl: nil)`，並在擷取語音內容時保持 `earBoostActive=true`。耳朵會放大 (1.9x) 並顯示圓形耳孔以提高辨識度，接著在靜音 1 秒後透過 `stopVoiceEars()` 恢復。僅由應用程式內的語音管線 (voice pipeline) 發送。
- **運作中 (Working，智慧代理執行中)：** `AppState.isWorking=true` 會觸發「尾巴/腿部快跑」微動作：在任務進行時，腿部擺動加快並有輕微位移。目前僅在 WebChat 智慧代理執行時切換；在串接其他長時工作時，請加入相同的切換機制。

串接點

- 語音喚醒：runtime/tester 在觸發時呼叫 `AppState.triggerVoiceEars(ttl: nil)`，並在靜音 1 秒後呼叫 `stopVoiceEars()` 以符合擷取視窗。
- 智慧代理活動：在工作期間設定 `AppStateStore.shared.setWorking(true/false)`（WebChat 智慧代理呼叫中已完成）。請保持區間短暫，並在 `defer` 區塊中重設，以避免動畫卡住。

形狀與尺寸

- 基礎圖示於 `CritterIconRenderer.makeIcon(blink:legWiggle:earWiggle:earScale:earHoles:)` 中繪製。
- 耳朵比例預設為 `1.0`；語音增強會將 `earScale` 設為 `1.9` 並切換 `earHoles=true`，且不改變整體框架（18×18 pt 的模板圖片渲染至 36×36 px 的 Retina 支援存儲中）。
- 快跑 (Scurry) 使用高達 ~1.0 的腿部擺動及輕微的水平抖動；這會疊加在現有的閒置擺動之上。

行為說明

- 耳朵/運作中狀態不提供外部 CLI/broker 切換；請保持在應用程式內部訊號觸發，以避免不必要的閃動。
- 保持 TTL 短暫 (<10s)，以便在工作掛起時圖示能快速恢復至基準狀態。
