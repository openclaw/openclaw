---
read_when:
    - ドキュメントの全体マップを確認したい場合
summary: すべての OpenClaw ドキュメントへのリンクをまとめたハブ
title: ドキュメントハブ
x-i18n:
    generated_at: "2026-04-02T07:54:44Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: a9533ecbdb8729005300614ced225532a80c0b33e6ab3687a50eae30917dbdda
    source_path: start/hubs.md
    workflow: 15
---

# ドキュメントハブ

<Note>
OpenClaw を初めて使う方は、[はじめに](/start/getting-started)から始めてください。
</Note>

これらのハブを使って、左ナビゲーションに表示されない詳細解説やリファレンスドキュメントを含む、すべてのページを確認できます。

## ここから始める

- [インデックス](/)
- [はじめに](/start/getting-started)
- [オンボーディング](/start/onboarding)
- [オンボーディング（CLI）](/start/wizard)
- [セットアップ](/start/setup)
- [ダッシュボード（ローカル Gateway ゲートウェイ）](http://127.0.0.1:18789/)
- [ヘルプ](/help)
- [ドキュメント一覧](/start/docs-directory)
- [設定](/gateway/configuration)
- [設定の例](/gateway/configuration-examples)
- [OpenClaw アシスタント](/start/openclaw)
- [ショーケース](/start/showcase)
- [ロア](/start/lore)

## インストール + アップデート

- [Docker](/install/docker)
- [Nix](/install/nix)
- [アップデート / ロールバック](/install/updating)
- [Bun ワークフロー（実験的）](/install/bun)

## コアコンセプト

- [アーキテクチャ](/concepts/architecture)
- [機能](/concepts/features)
- [ネットワークハブ](/network)
- [エージェントランタイム](/concepts/agent)
- [エージェントワークスペース](/concepts/agent-workspace)
- [メモリ](/concepts/memory)
- [エージェントループ](/concepts/agent-loop)
- [ストリーミング + チャンキング](/concepts/streaming)
- [マルチエージェントルーティング](/concepts/multi-agent)
- [コンパクション](/concepts/compaction)
- [セッション](/concepts/session)
- [セッションプルーニング](/concepts/session-pruning)
- [セッションツール](/concepts/session-tool)
- [キュー](/concepts/queue)
- [スラッシュコマンド](/tools/slash-commands)
- [RPC アダプター](/reference/rpc)
- [TypeBox スキーマ](/concepts/typebox)
- [タイムゾーン処理](/concepts/timezone)
- [プレゼンス](/concepts/presence)
- [ディスカバリーとトランスポート](/gateway/discovery)
- [Bonjour](/gateway/bonjour)
- [チャネルルーティング](/channels/channel-routing)
- [グループ](/channels/groups)
- [グループメッセージ](/channels/group-messages)
- [モデルフェイルオーバー](/concepts/model-failover)
- [OAuth](/concepts/oauth)

## プロバイダー + イングレス

- [チャットチャネルハブ](/channels)
- [モデルプロバイダーハブ](/providers/models)
- [WhatsApp](/channels/whatsapp)
- [Telegram](/channels/telegram)
- [Slack](/channels/slack)
- [Discord](/channels/discord)
- [Mattermost](/channels/mattermost)（プラグイン）
- [Signal](/channels/signal)
- [BlueBubbles (iMessage)](/channels/bluebubbles)
- [iMessage（レガシー）](/channels/imessage)
- [位置情報パース](/channels/location)
- [WebChat](/web/webchat)
- [Webhook](/automation/webhook)
- [Gmail Pub/Sub](/automation/gmail-pubsub)

## Gateway ゲートウェイ + 運用

- [Gateway ゲートウェイ ランブック](/gateway)
- [ネットワークモデル](/gateway/network-model)
- [Gateway ゲートウェイ ペアリング](/gateway/pairing)
- [Gateway ゲートウェイ ロック](/gateway/gateway-lock)
- [バックグラウンドプロセス](/gateway/background-process)
- [ヘルス](/gateway/health)
- [ハートビート](/gateway/heartbeat)
- [Doctor](/gateway/doctor)
- [ロギング](/gateway/logging)
- [サンドボックス化](/gateway/sandboxing)
- [ダッシュボード](/web/dashboard)
- [コントロール UI](/web/control-ui)
- [リモートアクセス](/gateway/remote)
- [リモート Gateway ゲートウェイ README](/gateway/remote-gateway-readme)
- [Tailscale](/gateway/tailscale)
- [セキュリティ](/gateway/security)
- [トラブルシューティング](/gateway/troubleshooting)

## ツール + 自動化

- [ツールサーフェス](/tools)
- [OpenProse](/prose)
- [CLI リファレンス](/cli)
- [Exec ツール](/tools/exec)
- [PDF ツール](/tools/pdf)
- [昇格モード](/tools/elevated)
- [Cron ジョブ](/automation/cron-jobs)
- [Cron vs ハートビート](/automation/cron-vs-heartbeat)
- [Thinking + verbose](/tools/thinking)
- [モデル](/concepts/models)
- [サブエージェント](/tools/subagents)
- [Agent send CLI](/tools/agent-send)
- [ターミナル UI](/web/tui)
- [ブラウザコントロール](/tools/browser)
- [ブラウザ（Linux トラブルシューティング）](/tools/browser-linux-troubleshooting)
- [投票](/automation/poll)

## ノード、メディア、音声

- [ノード概要](/nodes)
- [カメラ](/nodes/camera)
- [画像](/nodes/images)
- [オーディオ](/nodes/audio)
- [位置情報コマンド](/nodes/location-command)
- [音声ウェイク](/nodes/voicewake)
- [トークモード](/nodes/talk)

## プラットフォーム

- [プラットフォーム概要](/platforms)
- [macOS](/platforms/macos)
- [iOS](/platforms/ios)
- [Android](/platforms/android)
- [Windows (WSL2)](/platforms/windows)
- [Linux](/platforms/linux)
- [Web サーフェス](/web)

## macOS コンパニオンアプリ（上級者向け）

- [macOS 開発セットアップ](/platforms/mac/dev-setup)
- [macOS メニューバー](/platforms/mac/menu-bar)
- [macOS 音声ウェイク](/platforms/mac/voicewake)
- [macOS 音声オーバーレイ](/platforms/mac/voice-overlay)
- [macOS WebChat](/platforms/mac/webchat)
- [macOS Canvas](/platforms/mac/canvas)
- [macOS 子プロセス](/platforms/mac/child-process)
- [macOS ヘルス](/platforms/mac/health)
- [macOS アイコン](/platforms/mac/icon)
- [macOS ロギング](/platforms/mac/logging)
- [macOS パーミッション](/platforms/mac/permissions)
- [macOS リモート](/platforms/mac/remote)
- [macOS 署名](/platforms/mac/signing)
- [macOS Gateway ゲートウェイ (launchd)](/platforms/mac/bundled-gateway)
- [macOS XPC](/platforms/mac/xpc)
- [macOS Skills](/platforms/mac/skills)
- [macOS Peekaboo](/platforms/mac/peekaboo)

## 拡張機能 + プラグイン

- [プラグイン概要](/tools/plugin)
- [プラグインの構築](/plugins/building-plugins)
- [プラグインマニフェスト](/plugins/manifest)
- [エージェントツール](/plugins/building-plugins#registering-agent-tools)
- [プラグインバンドル](/plugins/bundles)
- [コミュニティプラグイン](/plugins/community)
- [機能拡張クックブック](/tools/capability-cookbook)
- [音声通話プラグイン](/plugins/voice-call)
- [Zalo ユーザープラグイン](/plugins/zalouser)

## ワークスペース + テンプレート

- [Skills](/tools/skills)
- [ClawHub](/tools/clawhub)
- [Skills 設定](/tools/skills-config)
- [デフォルト AGENTS](/reference/AGENTS.default)
- [テンプレート: AGENTS](/reference/templates/AGENTS)
- [テンプレート: BOOTSTRAP](/reference/templates/BOOTSTRAP)
- [テンプレート: HEARTBEAT](/reference/templates/HEARTBEAT)
- [テンプレート: IDENTITY](/reference/templates/IDENTITY)
- [テンプレート: SOUL](/reference/templates/SOUL)
- [テンプレート: TOOLS](/reference/templates/TOOLS)
- [テンプレート: USER](/reference/templates/USER)

## プロジェクト

- [クレジット](/reference/credits)

## テスト + リリース

- [テスト](/reference/test)
- [リリースポリシー](/reference/RELEASING)
- [デバイスモデル](/reference/device-models)
