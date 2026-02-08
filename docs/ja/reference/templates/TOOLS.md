---
summary: 「TOOLS.md のためのワークスペーステンプレート」
read_when:
  - ワークスペースを手動でブートストラップする場合
x-i18n:
  source_path: reference/templates/TOOLS.md
  source_hash: 3ed08cd537620749
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:23:04Z
---

# TOOLS.md - ローカルノート

Skills は、ツールが「どのように」動作するかを定義します。このファイルは「あなた」固有の詳細、つまりあなたのセットアップに固有の事柄のためのものです。

## ここに記載する内容

次のようなものです。

- カメラの名称と設置場所
- SSH ホストとエイリアス
- TTS の優先音声
- スピーカー／部屋の名称
- デバイスのニックネーム
- 環境固有のあらゆる情報

## 例

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

## 分ける理由

Skills は共有されます。あなたのセットアップはあなたのものです。分離しておくことで、ノートを失うことなく Skills を更新でき、インフラを漏らさずに Skills を共有できます。

---

仕事を進めるうえで役立つものを自由に追加してください。これはあなたのチートシートです。
