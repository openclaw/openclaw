---
summary: "ペアリングの概要：誰があなたに DM を送信できるか、どのノードが参加できるかを承認します"
read_when:
  - DM アクセス制御の設定
  - 新しい iOS／Android ノードのペアリング
  - OpenClaw のセキュリティ体制の確認
title: "ペアリング"
x-i18n:
  source_path: channels/pairing.md
  source_hash: cc6ce9c71db6d96d
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:20:47Z
---

# ペアリング

「ペアリング」は、OpenClaw における明示的な **オーナー承認** の手順です。
次の 2 つの場面で使用されます。

1. **DM ペアリング**（どの送信者がボットと会話できるか）
2. **ノード ペアリング**（どのデバイス／ノードが ゲートウェイ ネットワークに参加できるか）

セキュリティの背景： [Security](/gateway/security)

## 1) DM ペアリング（受信チャットのアクセス）

チャンネルが DM ポリシー `pairing` で設定されている場合、未承認の送信者には短いコードが発行され、承認するまでメッセージは **処理されません**。

既定の DM ポリシーは次に記載されています： [Security](/gateway/security)

ペアリングコード：

- 8 文字、英大文字、紛らわしい文字は含みません（`0O1I`）。
- **1 時間後に失効** します。ボットは、新しいリクエストが作成されたときにのみペアリングメッセージを送信します（送信者あたり概ね 1 時間に 1 回）。
- 保留中の DM ペアリングリクエストは、既定で **チャンネルあたり 3 件** に制限されます。いずれかが失効または承認されるまで、追加のリクエストは無視されます。

### 送信者を承認する

```bash
openclaw pairing list telegram
openclaw pairing approve telegram <CODE>
```

対応チャンネル： `telegram`、`whatsapp`、`signal`、`imessage`、`discord`、`slack`。

### 状態の保存場所

`~/.openclaw/credentials/` の配下に保存されます：

- 保留中のリクエスト： `<channel>-pairing.json`
- 承認済みの許可リスト ストア： `<channel>-allowFrom.json`

これらは機密として扱ってください（アシスタントへのアクセスを制御します）。

## 2) ノード デバイスのペアリング（iOS／Android／macOS／ヘッドレス ノード）

ノードは、`role: node` を用いた **デバイス** として Gateway（ゲートウェイ）に接続します。Gateway（ゲートウェイ）は、承認が必要なデバイス ペアリング リクエストを作成します。

### ノード デバイスを承認する

```bash
openclaw devices list
openclaw devices approve <requestId>
openclaw devices reject <requestId>
```

### ノード ペアリングの状態保存

`~/.openclaw/devices/` の配下に保存されます：

- `pending.json`（短期間のみ有効；保留中のリクエストは失効します）
- `paired.json`（ペアリング済みデバイス＋トークン）

### 注記

- レガシーの `node.pair.*` API（CLI： `openclaw nodes pending/approve`）は、ゲートウェイ所有の別個のペアリング ストアです。WS ノードでは、引き続きデバイス ペアリングが必要です。

## 関連ドキュメント

- セキュリティ モデル＋プロンプト インジェクション： [Security](/gateway/security)
- 安全な更新（doctor の実行）： [Updating](/install/updating)
- チャンネル設定：
  - Telegram： [Telegram](/channels/telegram)
  - WhatsApp： [WhatsApp](/channels/whatsapp)
  - Signal： [Signal](/channels/signal)
  - BlueBubbles（iMessage）： [BlueBubbles](/channels/bluebubbles)
  - iMessage（レガシー）： [iMessage](/channels/imessage)
  - Discord： [Discord](/channels/discord)
  - Slack： [Slack](/channels/slack)
