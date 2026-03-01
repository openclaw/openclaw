---
summary: "OpenClawのチャンネル、ルーティング、メディア、UXにわたる機能一覧"
read_when:
  - You want a full list of what OpenClaw supports
title: "機能"
---

## ハイライト

<Columns>
  <Card title="チャンネル" icon="message-square">
    WhatsApp、Telegram、Discord、iMessageを単一のGatewayで。
  </Card>
  <Card title="プラグイン" icon="plug">
    エクステンションでMattermostなどを追加。
  </Card>
  <Card title="ルーティング" icon="route">
    分離されたセッションによるマルチエージェントルーティング。
  </Card>
  <Card title="メディア" icon="image">
    画像、音声、ドキュメントの入出力。
  </Card>
  <Card title="アプリとUI" icon="monitor">
    WebコントロールUIとmacOSコンパニオンアプリ。
  </Card>
  <Card title="モバイルノード" icon="smartphone">
    Canvas対応のiOSおよびAndroidノード。
  </Card>
</Columns>

## 全機能リスト

- WhatsApp Web（Baileys）経由のWhatsApp統合
- Telegramボットサポート（grammY）
- Discordボットサポート（channels.discord.js）
- Mattermostボットサポート（プラグイン）
- ローカルimsg CLI（macOS）経由のiMessage統合
- RPCモードのPi向けエージェントブリッジ（ツールストリーミング付き）
- 長い応答のためのストリーミングとチャンキング
- ワークスペースまたは送信者ごとに分離されたセッションによるマルチエージェントルーティング
- OAuth経由のAnthropicおよびOpenAIのサブスクリプション認証
- セッション: ダイレクトチャットは共有`main`に集約、グループは分離
- メンションベースのアクティベーションによるグループチャットサポート
- 画像、音声、ドキュメントのメディアサポート
- オプションの音声メモトランスクリプションフック
- WebChatとmacOSメニューバーアプリ
- ペアリングとCanvasサーフェスを備えたiOSノード
- ペアリング、Canvas、チャット、カメラを備えたAndroidノード

<Note>
レガシーのClaude、Codex、Gemini、Opencodeパスは削除されました。Piが唯一のコーディングエージェントパスです。
</Note>
