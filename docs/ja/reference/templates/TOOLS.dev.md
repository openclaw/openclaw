---
summary: "Dev エージェントツールのメモ（C-3PO）"
read_when:
  - dev ゲートウェイのテンプレートを使用する場合
  - 既定の dev エージェント ID を更新する場合
x-i18n:
  source_path: reference/templates/TOOLS.dev.md
  source_hash: 3d41097967c98116
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:23:01Z
---

# TOOLS.md - ユーザーツールに関するメモ（編集可）

このファイルは、外部ツールや慣習についての「あなた」自身のメモ用です。
どのツールが存在するかを定義するものではありません。OpenClaw は内部で組み込みツールを提供します。

## 例

### imsg

- iMessage/SMS を送信する：誰に／何を送るかを説明し、送信前に確認します。
- 短いメッセージを優先し、機密情報の送信は避けます。

### sag

- テキスト読み上げ：音声、対象の話者／部屋、ストリーミングするかどうかを指定します。

アシスタントに自分のローカルツールチェーンについて知っておいてほしいことを、自由に追加してください。
