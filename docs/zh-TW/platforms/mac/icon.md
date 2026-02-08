---
summary: 「OpenClaw 在 macOS 上的選單列圖示狀態與動畫」
read_when:
  - 變更選單列圖示行為時
title: 「選單列圖示」
x-i18n:
  source_path: platforms/mac/icon.md
  source_hash: a67a6e6bbdc2b611
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:28:44Z
---

# 選單列圖示狀態

作者：steipete · 更新：2025-12-06 · 範圍：macOS 應用程式（`apps/macos`）

- **閒置：** 一般圖示動畫（眨眼、偶爾擺動）。
- **暫停：** 狀態項目使用 `appearsDisabled`；無任何動作。
- **語音觸發（大耳朵）：** 語音喚醒偵測器在聽到喚醒詞時呼叫 `AppState.triggerVoiceEars(ttl: nil)`，並在擷取語句期間維持 `earBoostActive=true`。耳朵等比例放大（1.9x），為了可讀性出現圓形耳洞，接著在 1 秒無聲後透過 `stopVoiceEars()` 回落。僅由應用程式內的語音管線觸發。
- **工作中（代理程式執行）：** `AppState.isWorking=true` 觸發「尾巴／腿部疾走」的微動作：腿部擺動加快，並在工作進行中產生輕微位移。目前在 WebChat 代理程式執行期間切換；當你串接其他長時間任務時，請在其周圍加入相同的切換。

接線點

- 語音喚醒：在觸發時由 runtime/tester 呼叫 `AppState.triggerVoiceEars(ttl: nil)`，並在 1 秒無聲後呼叫 `stopVoiceEars()`，以符合擷取視窗。
- 代理程式活動：在工作區段前後設定 `AppStateStore.shared.setWorking(true/false)`（WebChat 代理程式呼叫中已完成）。請保持區段短，並在 `defer` 區塊中重設，以避免動畫卡住。

形狀與尺寸

- 基礎圖示繪製於 `CritterIconRenderer.makeIcon(blink:legWiggle:earWiggle:earScale:earHoles:)`。
- 耳朵縮放預設為 `1.0`；語音增強設定為 `earScale=1.9`，並切換 `earHoles=true`，且不改變整體外框（18×18 pt 的樣板影像，渲染到 36×36 px 的 Retina 背板儲存）。
- 疾走效果使用腿部擺動最高約 ~1.0，並加入小幅水平晃動；此效果會疊加到任何既有的閒置擺動之上。

行為注意事項

- 沒有外部 CLI／代理切換可控制耳朵／工作狀態；請維持在應用程式自身的訊號內部，以避免意外頻繁切換。
- 請將 TTL 保持在短時間（<10s），以便在工作卡住時圖示能快速回到基準狀態。
