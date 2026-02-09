---
summary: "チャンネル、ルーティング、メディア、UX にわたる OpenClaw の機能。"
read_when:
  - OpenClaw がサポートする内容の全一覧を確認したい場合
title: "機能"
---

## Highlights

<Columns>
  <Card title="Channels" icon="message-square">
    単一の Gateway（ゲートウェイ）で WhatsApp、Telegram、Discord、iMessage に対応します。
  </Card>
  <Card title="Plugins" icon="plug">
    拡張機能で Mattermost などを追加できます。
  </Card>
  <Card title="Routing" icon="route">
    分離されたセッションによるマルチエージェントルーティング。
  </Card>
  <Card title="Media" icon="image">
    画像、音声、ドキュメントの入出力。
  </Card>
  <Card title="Apps and UI" icon="monitor">
    Web Control UI と macOS コンパニオンアプリ。
  </Card>
  <Card title="Mobile nodes" icon="smartphone">
    Canvas 対応の iOS および Android ノード。
  </Card>
</Columns>

## Full list

- WhatsApp Web（Baileys）経由の WhatsApp 連携
- Telegram ボット対応（grammY）
- Discord ボット対応（channels.discord.js）
- Mattermost ボット対応（プラグイン）
- ローカルの imsg CLI（macOS）経由の iMessage 連携
- ツールストリーミングを備えた RPC モードでの Pi 向けエージェントブリッジ
- 長い応答向けのストリーミングおよびチャンク化
- ワークスペースまたは送信者ごとに分離されたセッションのためのマルチエージェントルーティング
- OAuth による Anthropic および OpenAI のサブスクリプション認証
- セッション：ダイレクトチャットは共有の `main` に集約され、グループは分離されます
- メンションベースのアクティベーションによるグループチャット対応
- 画像、音声、ドキュメントのメディア対応
- オプションのボイスノート文字起こしフック
- WebChat および macOS メニューバーアプリ
- ペアリングと Canvas サーフェスを備えた iOS ノード
- ペアリング、Canvas、チャット、カメラを備えた Android ノード

<Note>
従来のクロード、コーデックス、Gemini、および Opencode パスが削除されました。 
従来の Claude、Codex、Gemini、Opencode のパスは削除されています。Pi が唯一の
コーディングエージェントパスです。

</Note>
