---
summary: 「TOOLS.md 的工作區範本」
read_when:
  - 手動引導建立工作區時
x-i18n:
  source_path: reference/templates/TOOLS.md
  source_hash: 3ed08cd537620749
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:29:06Z
---

# TOOLS.md - 本機備註

Skills 定義了工具「如何」運作。此檔案用於記錄「你」的特定設定——也就是只屬於你環境的內容。

## 這裡該放什麼

例如：

- 攝影機名稱與位置
- SSH 主機與別名
- 偏好的 TTS 語音
- 喇叭／房間名稱
- 裝置暱稱
- 任何與環境相關的事項

## 範例

```markdown
### Cameras

- living-room → Main area, 180° wide angle
- front-door → Entrance, motion-triggered

### SSH

- home-server → 192.168.1.100, user: admin

### TTS

- Preferred voice: "Nova" (warm, slightly British)
- Default speaker: Kitchen HomePod
```

## 為什麼要分開？

Skills 是共用的；你的設定是你的。將兩者分開，代表你可以在不遺失筆記的情況下更新 Skills，也能在不洩漏基礎架構的前提下分享 Skills。

---

加入任何能幫助你完成工作的內容。這是你的速查表。
