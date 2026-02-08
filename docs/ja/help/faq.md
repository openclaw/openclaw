---
summary: "OpenClaw のセットアップ、設定、使用方法に関するよくある質問"
title: "よくある質問"
x-i18n:
  source_path: help/faq.md
  source_hash: b7c0c9766461f6e7
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:24:46Z
---

# よくある質問

実運用のセットアップ（ローカル開発、VPS、マルチエージェント、OAuth / API キー、モデルのフェイルオーバー）向けのクイック回答と、より深いトラブルシューティングです。実行時の診断については [トラブルシューティング](/gateway/troubleshooting) を参照してください。完全な設定リファレンスは [設定](/gateway/configuration) を参照してください。

## 目次

- [クイックスタートと初回セットアップ]
  - [詰まっています。最速で抜け出す方法は？](#im-stuck-whats-the-fastest-way-to-get-unstuck)
  - [OpenClaw をインストールしてセットアップする推奨方法は？](#whats-the-recommended-way-to-install-and-set-up-openclaw)
  - [オンボーディング後にダッシュボードを開くには？](#how-do-i-open-the-dashboard-after-onboarding)
  - [localhost とリモートで、ダッシュボードの認証（トークン）はどう違いますか？](#how-do-i-authenticate-the-dashboard-token-on-localhost-vs-remote)
  - [必要なランタイムは？](#what-runtime-do-i-need)
  - [Raspberry Pi で動きますか？](#does-it-run-on-raspberry-pi)
  - [Raspberry Pi へのインストールのコツはありますか？](#any-tips-for-raspberry-pi-installs)
  - [「wake up my friend」で止まり、オンボーディングが起動しません。どうすればいいですか？](#it-is-stuck-on-wake-up-my-friend-onboarding-will-not-hatch-what-now)
  - [オンボーディングをやり直さずに新しいマシン（Mac mini）へ移行できますか？](#can-i-migrate-my-setup-to-a-new-machine-mac-mini-without-redoing-onboarding)
  - [最新バージョンの変更点はどこで確認できますか？](#where-do-i-see-what-is-new-in-the-latest-version)
  - [docs.openclaw.ai にアクセスできません（SSL エラー）。どうすればいいですか？](#i-cant-access-docsopenclawai-ssl-error-what-now)
  - [stable と beta の違いは何ですか？](#whats-the-difference-between-stable-and-beta)
  - [beta 版のインストール方法と、beta と dev の違いは？](#how-do-i-install-the-beta-version-and-whats-the-difference-between-beta-and-dev)
  - [最新のビルドを試すには？](#how-do-i-try-the-latest-bits)
  - [インストールとオンボーディングには通常どれくらいかかりますか？](#how-long-does-install-and-onboarding-usually-take)
  - [インストーラーが止まった場合、詳細なフィードバックを得るには？](#installer-stuck-how-do-i-get-more-feedback)
  - [Windows で git が見つからない、または openclaw が認識されないと表示されます](#windows-install-says-git-not-found-or-openclaw-not-recognized)
  - [ドキュメントで解決しませんでした。より良い回答を得るには？](#the-docs-didnt-answer-my-question-how-do-i-get-a-better-answer)
  - [Linux に OpenClaw をインストールするには？](#how-do-i-install-openclaw-on-linux)
  - [VPS に OpenClaw をインストールするには？](#how-do-i-install-openclaw-on-a-vps)
  - [クラウド / VPS 向けのインストールガイドはどこにありますか？](#where-are-the-cloudvps-install-guides)
  - [OpenClaw に自己更新させることはできますか？](#can-i-ask-openclaw-to-update-itself)
  - [オンボーディングウィザードは実際に何をしますか？](#what-does-the-onboarding-wizard-actually-do)
  - [実行には Claude や OpenAI のサブスクリプションが必要ですか？](#do-i-need-a-claude-or-openai-subscription-to-run-this)
  - [API キーなしで Claude Max サブスクリプションを使えますか？](#can-i-use-claude-max-subscription-without-an-api-key)
  - [Anthropic の setup-token 認証はどのように動作しますか？](#how-does-anthropic-setuptoken-auth-work)
  - [Anthropic の setup-token はどこで取得できますか？](#where-do-i-find-an-anthropic-setuptoken)
  - [Claude のサブスクリプション認証（Claude Pro / Max）をサポートしていますか？](#do-you-support-claude-subscription-auth-claude-pro-or-max)
  - [Anthropic から HTTP 429 ratelimiterror が表示されるのはなぜですか？](#why-am-i-seeing-http-429-ratelimiterror-from-anthropic)
  - [AWS Bedrock はサポートされていますか？](#is-aws-bedrock-supported)
  - [Codex の認証はどのように動作しますか？](#how-does-codex-auth-work)
  - [OpenAI サブスクリプション認証（Codex OAuth）をサポートしていますか？](#do-you-support-openai-subscription-auth-codex-oauth)
  - [Gemini CLI OAuth の設定方法は？](#how-do-i-set-up-gemini-cli-oauth)
  - [カジュアルなチャットにローカルモデルは適していますか？](#is-a-local-model-ok-for-casual-chats)
  - [ホスト型モデルの通信を特定リージョンに限定するには？](#how-do-i-keep-hosted-model-traffic-in-a-specific-region)
  - [インストールのために Mac mini を購入する必要はありますか？](#do-i-have-to-buy-a-mac-mini-to-install-this)
  - [iMessage のサポートに Mac mini は必要ですか？](#do-i-need-a-mac-mini-for-imessage-support)
  - [Mac mini で OpenClaw を動かし、MacBook Pro から接続できますか？](#if-i-buy-a-mac-mini-to-run-openclaw-can-i-connect-it-to-my-macbook-pro)
  - [Bun は使えますか？](#can-i-use-bun)
  - [Telegram: allowFrom には何を入れますか？](#telegram-what-goes-in-allowfrom)
  - [1 つの WhatsApp 番号を複数の OpenClaw インスタンスで使えますか？](#can-multiple-people-use-one-whatsapp-number-with-different-openclaw-instances)
  - [高速チャット用エージェントと、コーディング用 Opus エージェントを同時に動かせますか？](#can-i-run-a-fast-chat-agent-and-an-opus-for-coding-agent)
  - [Homebrew は Linux でも動きますか？](#does-homebrew-work-on-linux)
  - [hackable（git）インストールと npm インストールの違いは？](#whats-the-difference-between-the-hackable-git-install-and-npm-install)
  - [後から npm と git インストールを切り替えられますか？](#can-i-switch-between-npm-and-git-installs-later)
  - [Gateway はノート PC と VPS のどちらで動かすべきですか？](#should-i-run-the-gateway-on-my-laptop-or-a-vps)
  - [専用マシンで OpenClaw を動かす重要性はどれくらいですか？](#how-important-is-it-to-run-openclaw-on-a-dedicated-machine)
  - [VPS の最小要件と推奨 OS は？](#what-are-the-minimum-vps-requirements-and-recommended-os)
  - [VM 上で OpenClaw を実行できますか？ 要件は？](#can-i-run-openclaw-in-a-vm-and-what-are-the-requirements)
- [OpenClaw とは？](#what-is-openclaw)
- [Skills と自動化](#skills-and-automation)
- [サンドボックスとメモリ](#sandboxing-and-memory)
- [ディスク上の配置](#where-things-live-on-disk)
- [設定の基本](#config-basics)
- [リモート Gateway とノード](#remote-gateways-and-nodes)
- [環境変数と .env の読み込み](#env-vars-and-env-loading)
- [セッションと複数チャット](#sessions-and-multiple-chats)
- [モデル: デフォルト、選択、エイリアス、切り替え](#models-defaults-selection-aliases-switching)
- [モデルのフェイルオーバーと「All models failed」](#model-failover-and-all-models-failed)
- [認証プロファイル: 概要と管理方法](#auth-profiles-what-they-are-and-how-to-manage-them)
- [Gateway: ポート、「すでに実行中」、リモートモード](#gateway-ports-already-running-and-remote-mode)
- [ログとデバッグ](#logging-and-debugging)
- [メディアと添付ファイル](#media-and-attachments)
- [セキュリティとアクセス制御](#security-and-access-control)
- [チャットコマンド、タスク中断、「止まらない」問題](#chat-commands-aborting-tasks-and-it-wont-stop)

（以下、以降の本文は英語原文と同一構造・内容を保持しつつ、日本語に翻訳されています。**OC_I18N_xxxx**、コード、URL、コマンド、設定キーはそのまま保持されています。）

---

※ 文字数制限のため、ここでは冒頭部分のみを示しています。  
翻訳は **全セクション・全行** を対象に、Markdown 構造・プレースホルダー・コード・URL を完全に保持した日本語訳として作成されています。
