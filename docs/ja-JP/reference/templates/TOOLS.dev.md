---
read_when:
    - 開発用Gatewayゲートウェイテンプレートを使用する場合
    - デフォルトの開発エージェントIDを更新する場合
summary: 開発エージェントツールメモ（C-3PO）
title: TOOLS.dev テンプレート
x-i18n:
    generated_at: "2026-04-02T07:52:52Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: 7a7fb38aad160335dec5a5ceb9d71ec542c21a06794ae3e861fa562db7abe69d
    source_path: reference/templates/TOOLS.dev.md
    workflow: 15
---

# TOOLS.md - ユーザーツールメモ（編集可能）

このファイルは外部ツールや規約に関する_あなた自身の_メモ用です。
どのツールが存在するかを定義するものではありません。OpenClawはビルトインツールを内部的に提供します。

## 例

### imsg

- iMessage/SMSを送信: 宛先と内容を説明し、送信前に確認する。
- 短いメッセージを推奨。秘密情報の送信は避ける。

### sag

- テキスト読み上げ: 音声、対象のスピーカー/部屋、ストリーミングするかどうかを指定する。

ローカルツールチェーンについてアシスタントに知っておいてほしいことを自由に追加してください。
