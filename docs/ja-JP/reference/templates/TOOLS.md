---
read_when:
    - ワークスペースを手動でブートストラップする場合
summary: TOOLS.mdのワークスペーステンプレート
title: TOOLS.md テンプレート
x-i18n:
    generated_at: "2026-04-02T07:52:55Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: eed204d57e7221ae0455a87272da2b0730d6aee6ddd2446a851703276e4a96b7
    source_path: reference/templates/TOOLS.md
    workflow: 15
---

# TOOLS.md - ローカルメモ

Skillsはツールの_動作方法_を定義します。このファイルは_あなた固有の_詳細 — あなたのセットアップに固有の情報のためのものです。

## ここに記載するもの

たとえば：

- カメラの名前と設置場所
- SSHホストとエイリアス
- TTS用の優先音声
- スピーカー/部屋の名前
- デバイスのニックネーム
- 環境固有のあらゆる情報

## 例

```markdown
### カメラ

- living-room → メインエリア、180°広角
- front-door → 玄関、モーション検知

### SSH

- home-server → 192.168.1.100, user: admin

### TTS

- 優先音声: "Nova"（温かみのある、やや英国風）
- デフォルトスピーカー: キッチンのHomePod
```

## なぜ分けるのか？

Skillsは共有されます。あなたのセットアップはあなた固有のものです。分けておくことで、メモを失わずにSkillsを更新でき、インフラを漏洩させずにSkillsを共有できます。

---

仕事に役立つものなら何でも追加してください。これはあなたのチートシートです。
