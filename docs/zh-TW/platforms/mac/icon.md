---
summary: Menu bar icon states and animations for OpenClaw on macOS
read_when:
  - Changing menu bar icon behavior
title: Menu Bar Icon
---

# 功能表列圖示狀態

作者：steipete · 更新日期：2025-12-06 · 範圍：macOS 應用程式 (`apps/macos`)

- **閒置（Idle）：** 正常圖示動畫（閃爍，偶爾擺動）。
- **暫停（Paused）：** 狀態專案使用 `appearsDisabled`；無動作。
- **語音觸發（大耳朵）：** 語音喚醒偵測器在聽到喚醒詞時呼叫 `AppState.triggerVoiceEars(ttl: nil)`，在語音捕捉期間保持 `earBoostActive=true`。耳朵放大（1.9 倍），耳洞變圓形以提升可讀性，靜音 1 秒後透過 `stopVoiceEars()` 收回。此狀態僅由應用內語音流程觸發。
- **工作中（代理執行）：** `AppState.isWorking=true` 控制「尾巴/腿部快速移動」微動畫：工作進行時腿部擺動加快並略有偏移。目前在 WebChat 代理執行時切換；當你接入其他長時間任務時，也請加入相同切換。

接線點

- 語音喚醒：在觸發時由執行時/測試器呼叫 `AppState.triggerVoiceEars(ttl: nil)`，靜音 1 秒後呼叫 `stopVoiceEars()` 以符合捕捉時間窗。
- 代理活動：在工作期間設定 `AppStateStore.shared.setWorking(true/false)`（WebChat 代理呼叫中已實作）。保持時間段短暫，並在 `defer` 區塊中重置，以避免動畫卡住。

形狀與尺寸

- 基本圖示繪製於 `CritterIconRenderer.makeIcon(blink:legWiggle:earWiggle:earScale:earHoles:)`。
- 耳朵縮放預設為 `1.0`；語音增強時設定 `earScale=1.9` 並切換 `earHoles=true`，整體框架不變（18×18 pt 模板圖示渲染於 36×36 px Retina 背景存儲）。
- 快速移動使用腿部擺動至約 1.0，並帶有小幅水平抖動；此效果會疊加於現有閒置擺動。

行為備註

- 不提供外部 CLI/代理切換耳朵或工作狀態；保持在應用內部訊號控制，避免意外頻繁切換。
- 保持 TTL 短暫（<10 秒），以便任務掛起時圖示能快速回復基線狀態。
