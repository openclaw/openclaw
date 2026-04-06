---
read_when:
    - OpenClaw がサポートする機能の完全なリストを確認したいとき
summary: チャネル、ルーティング、メディア、UX にわたる OpenClaw の機能。
title: 機能
x-i18n:
    generated_at: "2026-04-02T07:36:59Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: 0fef7cf2e9b639853cdc3af8b3a017550438177c50216692d979abf947c2e2fd
    source_path: concepts/features.md
    workflow: 15
---

# 機能

## ハイライト

<Columns>
  <Card title="チャネル" icon="message-square">
    WhatsApp、Telegram、Discord、iMessage を単一の Gateway ゲートウェイで利用。
  </Card>
  <Card title="プラグイン" icon="plug">
    拡張機能で Mattermost などを追加。
  </Card>
  <Card title="ルーティング" icon="route">
    分離されたセッションによるマルチエージェントルーティング。
  </Card>
  <Card title="メディア" icon="image">
    画像、音声、ドキュメントの送受信。
  </Card>
  <Card title="アプリと UI" icon="monitor">
    Web コントロール UI と macOS コンパニオンアプリ。
  </Card>
  <Card title="モバイルノード" icon="smartphone">
    ペアリング、音声/チャット、リッチなデバイスコマンドを備えた iOS・Android ノード。
  </Card>
</Columns>

## 全機能リスト

**チャネル：**

- WhatsApp、Telegram、Discord、iMessage（組み込み）
- Mattermost、Matrix、Microsoft Teams、Nostr など（プラグイン）
- メンションベースのアクティベーションによるグループチャットサポート
- 許可リストとペアリングによるダイレクトメッセージの安全性

**エージェント：**

- ツールストリーミング対応の組み込みエージェントランタイム
- ワークスペースまたは送信者ごとに分離されたセッションによるマルチエージェントルーティング
- セッション：ダイレクトチャットは共有 `main` に集約、グループは分離
- 長いレスポンスのストリーミングとチャンク分割

**認証とプロバイダー：**

- 35 以上のモデルプロバイダー（Anthropic、OpenAI、Google など）
- OAuth によるサブスクリプション認証（例：OpenAI Codex）
- カスタムおよびセルフホスト型プロバイダーのサポート（vLLM、SGLang、Ollama、および任意の OpenAI 互換または Anthropic 互換エンドポイント）

**メディア：**

- 画像、音声、動画、ドキュメントの送受信
- ボイスメモの文字起こし
- 複数プロバイダーによるテキスト読み上げ

**アプリとインターフェース：**

- WebChat とブラウザコントロール UI
- macOS メニューバーコンパニオンアプリ
- ペアリング、Canvas、カメラ、画面録画、位置情報、音声対応の iOS ノード
- ペアリング、チャット、音声、Canvas、カメラ、デバイスコマンド対応の Android ノード

**ツールと自動化：**

- ブラウザ自動化、exec、サンドボックス化
- Web 検索（Brave、Perplexity、Gemini、Grok、Kimi、Firecrawl）
- cron ジョブとハートビートスケジューリング
- Skills、プラグイン、ワークフローパイプライン（Lobster）
