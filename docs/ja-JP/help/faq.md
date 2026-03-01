---
summary: "OpenClaw のセットアップ、設定、使用方法に関するよくある質問"
read_when:
  - セットアップ、インストール、オンボーディング、または実行時サポートに関するよくある質問に答えるとき
  - 詳細なデバッグの前にユーザーが報告した問題をトリアージするとき
title: "FAQ"
---

# FAQ

実際のセットアップ（ローカル Dev、VPS、マルチエージェント、OAuth/API キー、モデルフェイルオーバー）に対するクイックアンサーと詳細なトラブルシューティング。実行時の診断については [トラブルシューティング](/gateway/troubleshooting) を参照してください。設定の完全なリファレンスについては [設定](/gateway/configuration) を参照してください。

## 目次

- [クイックスタートと初回セットアップ]
  - [詰まっています。最速で解決するには？](#im-stuck-whats-the-fastest-way-to-get-unstuck)
  - [OpenClaw のインストールとセットアップの推奨方法は？](#whats-the-recommended-way-to-install-and-set-up-openclaw)
  - [オンボーディング後にダッシュボードを開くには？](#how-do-i-open-the-dashboard-after-onboarding)
  - [localhost とリモートでダッシュボードのトークン認証をするには？](#how-do-i-authenticate-the-dashboard-token-on-localhost-vs-remote)
  - [必要なランタイムは？](#what-runtime-do-i-need)
  - [Raspberry Pi で動作しますか？](#does-it-run-on-raspberry-pi)
  - [Raspberry Pi インストールのヒントは？](#any-tips-for-raspberry-pi-installs)
  - [「wake up my friend」で詰まる / オンボーディングが進まない。どうすれば？](#it-is-stuck-on-wake-up-my-friend-onboarding-will-not-hatch-what-now)
  - [オンボーディングをやり直さずに新しいマシン（Mac mini）にセットアップを移行できますか？](#can-i-migrate-my-setup-to-a-new-machine-mac-mini-without-redoing-onboarding)
  - [最新バージョンの変更点はどこで確認できますか？](#where-do-i-see-what-is-new-in-the-latest-version)
  - [docs.openclaw.ai にアクセスできない（SSL エラー）。どうすれば？](#i-cant-access-docsopenclawai-ssl-error-what-now)
  - [stable と beta の違いは？](#whats-the-difference-between-stable-and-beta)
  - [beta バージョンのインストール方法と、beta と dev の違いは？](#how-do-i-install-the-beta-version-and-whats-the-difference-between-beta-and-dev)
  - [最新ビットを試すには？](#how-do-i-try-the-latest-bits)
  - [インストールとオンボーディングにかかる時間は？](#how-long-does-install-and-onboarding-usually-take)
  - [インストーラーが詰まった。詳細情報を取得するには？](#installer-stuck-how-do-i-get-more-feedback)
  - [Windows インストールで git が見つからない、または openclaw が認識されない](#windows-install-says-git-not-found-or-openclaw-not-recognized)
  - [ドキュメントで質問の答えが見つからない。より良い答えを得るには？](#the-docs-didnt-answer-my-question-how-do-i-get-a-better-answer)
  - [Linux に OpenClaw をインストールするには？](#how-do-i-install-openclaw-on-linux)
  - [VPS に OpenClaw をインストールするには？](#how-do-i-install-openclaw-on-a-vps)
  - [クラウド/VPS インストールガイドはどこにありますか？](#where-are-the-cloudvps-install-guides)
  - [OpenClaw に自己更新を依頼できますか？](#can-i-ask-openclaw-to-update-itself)
  - [オンボーディングウィザードは実際に何をしますか？](#what-does-the-onboarding-wizard-actually-do)
  - [実行するために Claude または OpenAI のサブスクリプションが必要ですか？](#do-i-need-a-claude-or-openai-subscription-to-run-this)
  - [API キーなしで Claude Max サブスクリプションを使用できますか？](#can-i-use-claude-max-subscription-without-an-api-key)
  - [Anthropic の「setup-token」認証はどのように機能しますか？](#how-does-anthropic-setuptoken-auth-work)
  - [Anthropic の setup-token はどこで入手できますか？](#where-do-i-find-an-anthropic-setuptoken)
  - [Claude サブスクリプション認証（Claude Pro または Max）をサポートしていますか？](#do-you-support-claude-subscription-auth-claude-pro-or-max)
  - [Anthropic から `HTTP 429: rate_limit_error` が表示されるのはなぜですか？](#why-am-i-seeing-http-429-ratelimiterror-from-anthropic)
  - [AWS Bedrock はサポートされていますか？](#is-aws-bedrock-supported)
  - [Codex 認証はどのように機能しますか？](#how-does-codex-auth-work)
  - [OpenAI サブスクリプション認証（Codex OAuth）をサポートしていますか？](#do-you-support-openai-subscription-auth-codex-oauth)
  - [Gemini CLI OAuth をセットアップするには？](#how-do-i-set-up-gemini-cli-oauth)
  - [カジュアルなチャットにローカルモデルは適していますか？](#is-a-local-model-ok-for-casual-chats)
  - [ホスト型モデルのトラフィックを特定のリージョンに保つには？](#how-do-i-keep-hosted-model-traffic-in-a-specific-region)
  - [インストールするために Mac mini を購入する必要がありますか？](#do-i-have-to-buy-a-mac-mini-to-install-this)
  - [iMessage サポートに Mac mini が必要ですか？](#do-i-need-a-mac-mini-for-imessage-support)
  - [OpenClaw を実行するために Mac mini を購入した場合、MacBook Pro に接続できますか？](#if-i-buy-a-mac-mini-to-run-openclaw-can-i-connect-it-to-my-macbook-pro)
  - [Bun を使用できますか？](#can-i-use-bun)
  - [Telegram: `allowFrom` には何を入れますか？](#telegram-what-goes-in-allowfrom)
  - [複数のユーザーが 1 つの WhatsApp 番号を異なる OpenClaw インスタンスで使用できますか？](#can-multiple-people-use-one-whatsapp-number-with-different-openclaw-instances)
  - [「高速チャット」エージェントと「コーディング用 Opus」エージェントを実行できますか？](#can-i-run-a-fast-chat-agent-and-an-opus-for-coding-agent)
  - [Homebrew は Linux で動作しますか？](#does-homebrew-work-on-linux)
  - [ハッカブル（git）インストールと npm インストールの違いは？](#whats-the-difference-between-the-hackable-git-install-and-npm-install)
  - [後で npm インストールと git インストールを切り替えられますか？](#can-i-switch-between-npm-and-git-installs-later)
  - [Gateway はラップトップと VPS のどちらで実行すべきですか？](#should-i-run-the-gateway-on-my-laptop-or-a-vps)
  - [OpenClaw を専用マシンで実行することはどの程度重要ですか？](#how-important-is-it-to-run-openclaw-on-a-dedicated-machine)
  - [VPS の最小要件と推奨 OS は？](#what-are-the-minimum-vps-requirements-and-recommended-os)
  - [VM で OpenClaw を実行できますか？要件は何ですか？](#can-i-run-openclaw-in-a-vm-and-what-are-the-requirements)
- [OpenClaw とは？](#what-is-openclaw)
  - [OpenClaw を 1 段落で説明すると？](#what-is-openclaw-in-one-paragraph)
  - [価値提案は？](#whats-the-value-proposition)
  - [セットアップしました。最初に何をすべきですか？](#i-just-set-it-up-what-should-i-do-first)
  - [OpenClaw の日常的なユースケース上位 5 つは？](#what-are-the-top-five-everyday-use-cases-for-openclaw)
  - [OpenClaw は SaaS のリードジェン、アウトリーチ、広告、ブログを支援できますか？](#can-openclaw-help-with-lead-gen-outreach-ads-and-blogs-for-a-saas)
  - [Web 開発における Claude Code との比較での利点は？](#what-are-the-advantages-vs-claude-code-for-web-development)
- [スキルとオートメーション](#skills-and-automation)
  - [リポジトリを汚さずにスキルをカスタマイズするには？](#how-do-i-customize-skills-without-keeping-the-repo-dirty)
  - [カスタムフォルダーからスキルを読み込めますか？](#can-i-load-skills-from-a-custom-folder)
  - [タスクごとに異なるモデルを使用するには？](#how-can-i-use-different-models-for-different-tasks)
  - [重い作業中にボットがフリーズします。オフロードするには？](#the-bot-freezes-while-doing-heavy-work-how-do-i-offload-that)
  - [Cron またはリマインダーが発火しません。何を確認すべきですか？](#cron-or-reminders-do-not-fire-what-should-i-check)
  - [Linux にスキルをインストールするには？](#how-do-i-install-skills-on-linux)
  - [OpenClaw はスケジュールでタスクを実行したり、バックグラウンドで継続的に実行できますか？](#can-openclaw-run-tasks-on-a-schedule-or-continuously-in-the-background)
  - [Linux から Apple macOS 専用スキルを実行できますか？](#can-i-run-apple-macos-only-skills-from-linux)
  - [Notion または HeyGen の統合はありますか？](#do-you-have-a-notion-or-heygen-integration)
  - [ブラウザ乗っ取り用の Chrome 拡張機能をインストールするには？](#how-do-i-install-the-chrome-extension-for-browser-takeover)
- [サンドボックスとメモリ](#sandboxing-and-memory)
  - [サンドボックス専用のドキュメントはありますか？](#is-there-a-dedicated-sandboxing-doc)
  - [サンドボックスにホストフォルダーをバインドするには？](#how-do-i-bind-a-host-folder-into-the-sandbox)
  - [メモリはどのように機能しますか？](#how-does-memory-work)
  - [メモリが忘れ続けます。定着させるには？](#memory-keeps-forgetting-things-how-do-i-make-it-stick)
  - [メモリは永続しますか？制限は何ですか？](#does-memory-persist-forever-what-are-the-limits)
  - [セマンティックメモリ検索に OpenAI API キーが必要ですか？](#does-semantic-memory-search-require-an-openai-api-key)
- [ディスク上のデータの場所](#where-things-live-on-disk)
  - [OpenClaw で使用されるすべてのデータはローカルに保存されますか？](#is-all-data-used-with-openclaw-saved-locally)
  - [OpenClaw はデータをどこに保存しますか？](#where-does-openclaw-store-its-data)
  - [AGENTS.md / SOUL.md / USER.md / MEMORY.md はどこに置くべきですか？](#where-should-agentsmd-soulmd-usermd-memorymd-live)
  - [推奨されるバックアップ戦略は？](#whats-the-recommended-backup-strategy)
  - [OpenClaw を完全にアンインストールするには？](#how-do-i-completely-uninstall-openclaw)
  - [エージェントはワークスペースの外で作業できますか？](#can-agents-work-outside-the-workspace)
  - [リモートモードにいます。セッションストアはどこにありますか？](#im-in-remote-mode-where-is-the-session-store)
- [設定の基本](#config-basics)
  - [設定のフォーマットは何ですか？どこにありますか？](#what-format-is-the-config-where-is-it)
  - [`gateway.bind: "lan"`（または `"tailnet"`）を設定したら何もリッスンしない / UI が unauthorized と表示される](#i-set-gatewaybind-lan-or-tailnet-and-now-nothing-listens-the-ui-says-unauthorized)
  - [localhost でトークンが必要なのはなぜですか？](#why-do-i-need-a-token-on-localhost-now)
  - [設定変更後に再起動する必要がありますか？](#do-i-have-to-restart-after-changing-config)
  - [Web 検索（と Web フェッチ）を有効にするには？](#how-do-i-enable-web-search-and-web-fetch)
  - [config.apply で設定が消えました。回復して再発を防ぐには？](#configapply-wiped-my-config-how-do-i-recover-and-avoid-this)
  - [デバイス間で特定ワーカーを持つ中央 Gateway を実行するには？](#how-do-i-run-a-central-gateway-with-specialized-workers-across-devices)
  - [OpenClaw のブラウザはヘッドレスで実行できますか？](#can-the-openclaw-browser-run-headless)
  - [ブラウザコントロールに Brave を使用するには？](#how-do-i-use-brave-for-browser-control)
- [リモート Gateway とノード](#remote-gateways-and-nodes)
  - [Telegram、Gateway、ノード間でコマンドはどのように伝播しますか？](#how-do-commands-propagate-between-telegram-the-gateway-and-nodes)
  - [Gateway がリモートでホストされている場合、エージェントはどのようにコンピューターにアクセスできますか？](#how-can-my-agent-access-my-computer-if-the-gateway-is-hosted-remotely)
  - [Tailscale は接続されていますが返信がありません。どうすれば？](#tailscale-is-connected-but-i-get-no-replies-what-now)
  - [2 つの OpenClaw インスタンスは互いに通信できますか（ローカル + VPS）？](#can-two-openclaw-instances-talk-to-each-other-local-vps)
  - [複数のエージェントに個別の VPS が必要ですか？](#do-i-need-separate-vpses-for-multiple-agents)
  - [VPS からの SSH の代わりに個人のラップトップでノードを使用する利点はありますか？](#is-there-a-benefit-to-using-a-node-on-my-personal-laptop-instead-of-ssh-from-a-vps)
  - [ノードは Gateway サービスを実行しますか？](#do-nodes-run-a-gateway-service)
  - [設定を適用する API / RPC の方法はありますか？](#is-there-an-api-rpc-way-to-apply-config)
  - [最初のインストール向けの最小限の「まともな」設定は？](#whats-a-minimal-sane-config-for-a-first-install)
  - [VPS に Tailscale をセットアップして Mac から接続するには？](#how-do-i-set-up-tailscale-on-a-vps-and-connect-from-my-mac)
  - [Mac ノードをリモート Gateway（Tailscale Serve）に接続するには？](#how-do-i-connect-a-mac-node-to-a-remote-gateway-tailscale-serve)
  - [2 台目のラップトップにインストールすべきか、ノードを追加するだけにすべきか？](#should-i-install-on-a-second-laptop-or-just-add-a-node)
- [環境変数と .env の読み込み](#env-vars-and-env-loading)
  - [OpenClaw はどのように環境変数を読み込みますか？](#how-does-openclaw-load-environment-variables)
  - [「サービスで Gateway を起動したら環境変数が消えた。」どうすれば？](#i-started-the-gateway-via-the-service-and-my-env-vars-disappeared-what-now)
  - [`COPILOT_GITHUB_TOKEN` を設定しましたが、models status に「Shell env: off」と表示されます。なぜ？](#i-set-copilotgithubtoken-but-models-status-shows-shell-env-off-why)
- [セッションと複数のチャット](#sessions-and-multiple-chats)
  - [新しい会話を開始するには？](#how-do-i-start-a-fresh-conversation)
  - [`/new` を送らなければセッションは自動的にリセットされますか？](#do-sessions-reset-automatically-if-i-never-send-new)
  - [OpenClaw インスタンスのチーム（1 つの CEO と多くのエージェント）を作れますか？](#is-there-a-way-to-make-a-team-of-openclaw-instances-one-ceo-and-many-agents)
  - [タスクの途中でコンテキストが切り捨てられたのはなぜですか？防ぐには？](#why-did-context-get-truncated-midtask-how-do-i-prevent-it)
  - [インストールを維持したまま OpenClaw を完全にリセットするには？](#how-do-i-completely-reset-openclaw-but-keep-it-installed)
  - [「context too large」エラーが出ています。リセットまたはコンパクトするには？](#im-getting-context-too-large-errors-how-do-i-reset-or-compact)
  - [「LLM request rejected: messages.content.tool_use.input field required」が表示されるのはなぜですか？](#why-am-i-seeing-llm-request-rejected-messagescontenttool_useinput-field-required)
  - [30 分ごとにハートビートメッセージが届くのはなぜですか？](#why-am-i-getting-heartbeat-messages-every-30-minutes)
  - [WhatsApp グループに「ボットアカウント」を追加する必要がありますか？](#do-i-need-to-add-a-bot-account-to-a-whatsapp-group)
  - [WhatsApp グループの JID を取得するには？](#how-do-i-get-the-jid-of-a-whatsapp-group)
  - [OpenClaw がグループで返信しないのはなぜですか？](#why-doesnt-openclaw-reply-in-a-group)
  - [グループ/スレッドは DM とコンテキストを共有しますか？](#do-groupsthreads-share-context-with-dms)
  - [ワークスペースとエージェントはいくつ作成できますか？](#how-many-workspaces-and-agents-can-i-create)
  - [複数のボットやチャットを同時に実行できますか（Slack）？セットアップ方法は？](#can-i-run-multiple-bots-or-chats-at-the-same-time-slack-and-how-should-i-set-that-up)
- [モデル: デフォルト、選択、エイリアス、切り替え](#models-defaults-selection-aliases-switching)
  - [「デフォルトモデル」とは？](#what-is-the-default-model)
  - [推奨モデルは？](#what-model-do-you-recommend)
  - [設定を消去せずにモデルを切り替えるには？](#how-do-i-switch-models-without-wiping-my-config)
  - [セルフホスト型モデル（llama.cpp、vLLM、Ollama）を使用できますか？](#can-i-use-selfhosted-models-llamacpp-vllm-ollama)
  - [OpenClaw、Flawd、Krill はどのモデルを使用していますか？](#what-do-openclaw-flawd-and-krill-use-for-models)
  - [再起動なしでその場でモデルを切り替えるには？](#how-do-i-switch-models-on-the-fly-without-restarting)
  - [日常タスクに GPT 5.2、コーディングに Codex 5.3 を使用できますか？](#can-i-use-gpt-52-for-daily-tasks-and-codex-53-for-coding)
  - [「Model … is not allowed」と表示されて返信がないのはなぜですか？](#why-do-i-see-model-is-not-allowed-and-then-no-reply)
  - [「Unknown model: minimax/MiniMax-M2.1」が表示されるのはなぜですか？](#why-do-i-see-unknown-model-minimaxminimaxm21)
  - [デフォルトに MiniMax、複雑なタスクに OpenAI を使用できますか？](#can-i-use-minimax-as-my-default-and-openai-for-complex-tasks)
  - [opus / sonnet / gpt はビルトインショートカットですか？](#are-opus-sonnet-gpt-builtin-shortcuts)
  - [モデルショートカット（エイリアス）を定義/オーバーライドするには？](#how-do-i-defineoverride-model-shortcuts-aliases)
  - [OpenRouter や Z.AI などの他のプロバイダーからモデルを追加するには？](#how-do-i-add-models-from-other-providers-like-openrouter-or-zai)
- [モデルフェイルオーバーと「All models failed」](#model-failover-and-all-models-failed)
  - [フェイルオーバーはどのように機能しますか？](#how-does-failover-work)
  - [このエラーはどういう意味ですか？](#what-does-this-error-mean)
  - [`No credentials found for profile "anthropic:default"` の修正チェックリスト](#fix-checklist-for-no-credentials-found-for-profile-anthropicdefault)
  - [なぜ Google Gemini も試みて失敗したのですか？](#why-did-it-also-try-google-gemini-and-fail)
- [認証プロファイル: 概要と管理方法](#auth-profiles-what-they-are-and-how-to-manage-them)
  - [認証プロファイルとは？](#what-is-an-auth-profile)
  - [典型的なプロファイル ID は？](#what-are-typical-profile-ids)
  - [最初に試す認証プロファイルを制御できますか？](#can-i-control-which-auth-profile-is-tried-first)
  - [OAuth vs API キー: 違いは？](#oauth-vs-api-key-whats-the-difference)
- [Gateway: ポート、「already running」、リモートモード](#gateway-ports-already-running-and-remote-mode)
  - [Gateway が使用するポートは？](#what-port-does-the-gateway-use)
  - [`openclaw gateway status` が `Runtime: running` と表示するが `RPC probe: failed` になるのはなぜですか？](#why-does-openclaw-gateway-status-say-runtime-running-but-rpc-probe-failed)
  - [`openclaw gateway status` が `Config (cli)` と `Config (service)` で異なる値を表示するのはなぜですか？](#why-does-openclaw-gateway-status-show-config-cli-and-config-service-different)
  - [「another gateway instance is already listening」とはどういう意味ですか？](#what-does-another-gateway-instance-is-already-listening-mean)
  - [OpenClaw をリモートモードで実行するには（クライアントが別の Gateway に接続）？](#how-do-i-run-openclaw-in-remote-mode-client-connects-to-a-gateway-elsewhere)
  - [Control UI が「unauthorized」と表示される（または再接続し続ける）。どうすれば？](#the-control-ui-says-unauthorized-or-keeps-reconnecting-what-now)
  - [`gateway.bind: "tailnet"` を設定したがバインドできない / 何もリッスンしない](#i-set-gatewaybind-tailnet-but-it-cant-bind-nothing-listens)
  - [同じホストで複数の Gateway を実行できますか？](#can-i-run-multiple-gateways-on-the-same-host)
  - [「invalid handshake」/ コード 1008 とはどういう意味ですか？](#what-does-invalid-handshake-code-1008-mean)
- [ログとデバッグ](#logging-and-debugging)
  - [ログはどこにありますか？](#where-are-logs)
  - [Gateway サービスを起動/停止/再起動するには？](#how-do-i-startstoprestart-the-gateway-service)
  - [Windows でターミナルを閉じてしまいました。OpenClaw を再起動するには？](#i-closed-my-terminal-on-windows-how-do-i-restart-openclaw)
  - [Gateway は動作しているが返信が届かない。何を確認すべきですか？](#the-gateway-is-up-but-replies-never-arrive-what-should-i-check)
  - [「Disconnected from gateway: no reason」。どうすれば？](#disconnected-from-gateway-no-reason-what-now)
  - [Telegram の setMyCommands がネットワークエラーで失敗します。何を確認すべきですか？](#telegram-setmycommands-fails-with-network-errors-what-should-i-check)
  - [TUI に出力が表示されません。何を確認すべきですか？](#tui-shows-no-output-what-should-i-check)
  - [Gateway を完全に停止してから起動するには？](#how-do-i-completely-stop-then-start-the-gateway)
  - [わかりやすく説明: `openclaw gateway restart` vs `openclaw gateway`](#eli5-openclaw-gateway-restart-vs-openclaw-gateway)
  - [何かが失敗したときに詳細を取得する最速の方法は？](#whats-the-fastest-way-to-get-more-details-when-something-fails)
- [メディアと添付ファイル](#media-and-attachments)
  - [スキルで画像/PDF が生成されましたが、何も送信されませんでした](#my-skill-generated-an-imagepdf-but-nothing-was-sent)
- [セキュリティとアクセス制御](#security-and-access-control)
  - [OpenClaw を受信 DM に公開するのは安全ですか？](#is-it-safe-to-expose-openclaw-to-inbound-dms)
  - [プロンプトインジェクションは公開ボットだけの問題ですか？](#is-prompt-injection-only-a-concern-for-public-bots)
  - [ボットには独自のメール、GitHub アカウント、電話番号が必要ですか？](#should-my-bot-have-its-own-email-github-account-or-phone-number)
  - [テキストメッセージに対して自律性を与えることはできますか？安全ですか？](#can-i-give-it-autonomy-over-my-text-messages-and-is-that-safe)
  - [個人アシスタントタスクに安価なモデルを使用できますか？](#can-i-use-cheaper-models-for-personal-assistant-tasks)
  - [Telegram で `/start` を実行しましたが、ペアリングコードが届きませんでした](#i-ran-start-in-telegram-but-didnt-get-a-pairing-code)
  - [WhatsApp: 連絡先にメッセージを送りますか？ペアリングはどのように機能しますか？](#whatsapp-will-it-message-my-contacts-how-does-pairing-work)
- [チャットコマンド、タスクの中断、「止まらない」](#chat-commands-aborting-tasks-and-it-wont-stop)
  - [内部システムメッセージをチャットに表示されないようにするには？](#how-do-i-stop-internal-system-messages-from-showing-in-chat)
  - [実行中のタスクを停止/キャンセルするには？](#how-do-i-stopcancel-a-running-task)
  - [Telegram から Discord にメッセージを送るには？（「Cross-context messaging denied」）](#how-do-i-send-a-discord-message-from-telegram-crosscontext-messaging-denied)
  - [ボットが連続したメッセージを「無視」しているように感じるのはなぜですか？](#why-does-it-feel-like-the-bot-ignores-rapidfire-messages)


## 何かが壊れた場合の最初の 60 秒

1. **クイックステータス（最初のチェック）**

   ```bash
   openclaw status
   ```

   高速なローカルサマリー: OS + 更新、Gateway/サービスの到達可能性、エージェント/セッション、プロバイダー設定 + ランタイムの問題（Gateway に到達可能な場合）。

2. **共有可能なレポート**

   ```bash
   openclaw status --all
   ```

   ログテール付きの読み取り専用診断（トークンは除外）。

3. **デーモン + ポートの状態**

   ```bash
   openclaw gateway status
   ```

   スーパーバイザーのランタイム vs RPC の到達可能性、プローブターゲット URL、サービスが使用した可能性の高い設定を表示します。

4. **詳細プローブ**

   ```bash
   openclaw status --deep
   ```

   Gateway ヘルスチェック + プロバイダープローブを実行します（到達可能な Gateway が必要）。[ヘルス](/gateway/health) を参照してください。

5. **最新ログのテール**

   ```bash
   openclaw logs --follow
   ```

   RPC がダウンしている場合は、フォールバックとして:

   ```bash
   tail -f "$(ls -t /tmp/openclaw/openclaw-*.log | head -1)"
   ```

   ファイルログはサービスログとは別です。[ログ](/logging) と [トラブルシューティング](/gateway/troubleshooting) を参照してください。

6. **Doctor を実行（修復）**

   ```bash
   openclaw doctor
   ```

   設定/状態の修復/移行 + ヘルスチェックの実行。[Doctor](/gateway/doctor) を参照してください。

7. **Gateway スナップショット**

   ```bash
   openclaw health --json
   openclaw health --verbose   # エラー時にターゲット URL + 設定パスを表示
   ```

   実行中の Gateway にフルスナップショットを要求します（WS のみ）。[ヘルス](/gateway/health) を参照してください。

## クイックスタートと初回セットアップ

### 詰まっています。最速で解決するには？

**マシンを見ることができる**ローカル AI エージェントを使用してください。「詰まった」ケースのほとんどは**ローカルの設定や環境の問題**であり、リモートのヘルパーには検査できないため、Discord で質問するよりもはるかに効果的です。

- **Claude Code**: [https://www.anthropic.com/claude-code/](https://www.anthropic.com/claude-code/)
- **OpenAI Codex**: [https://openai.com/codex/](https://openai.com/codex/)

これらのツールはリポジトリを読み、コマンドを実行し、ログを検査し、マシンレベルのセットアップ（PATH、サービス、パーミッション、認証ファイル）の修正を支援できます。ハッカブル（git）インストールで**完全なソースチェックアウト**を提供してください:

```bash
curl -fsSL https://openclaw.ai/install.sh | bash -s -- --install-method git
```

これにより OpenClaw が **git チェックアウトからインストール**されるため、エージェントはコードとドキュメントを読み、実行中の正確なバージョンについて推論できます。後でインストーラーを `--install-method git` なしで再実行することで、いつでも stable に戻すことができます。

ヒント: エージェントに修正を**計画して監督**させ（ステップバイステップ）、必要なコマンドのみを実行させてください。これにより変更が小さく、監査しやすくなります。

実際のバグや修正を発見した場合は、GitHub Issue を作成するか PR を送ってください:
[https://github.com/openclaw/openclaw/issues](https://github.com/openclaw/openclaw/issues)
[https://github.com/openclaw/openclaw/pulls](https://github.com/openclaw/openclaw/pulls)

これらのコマンドから始めてください（助けを求める際は出力を共有してください）:

```bash
openclaw status
openclaw models status
openclaw doctor
```

各コマンドの機能:

- `openclaw status`: Gateway/エージェントのヘルス + 基本設定のクイックスナップショット。
- `openclaw models status`: プロバイダー認証 + モデルの可用性をチェック。
- `openclaw doctor`: 一般的な設定/状態の問題を検証・修復。

その他の便利な CLI チェック: `openclaw status --all`、`openclaw logs --follow`、
`openclaw gateway status`、`openclaw health --verbose`。

クイックデバッグループ: [何かが壊れた場合の最初の 60 秒](#first-60-seconds-if-somethings-broken)。
インストールドキュメント: [インストール](/install)、[インストーラーフラグ](/install/installer)、[更新](/install/updating)。

### OpenClaw のインストールとセットアップの推奨方法は？

リポジトリではソースから実行し、オンボーディングウィザードを使用することを推奨しています:

```bash
curl -fsSL https://openclaw.ai/install.sh | bash
openclaw onboard --install-daemon
```

ウィザードは UI アセットも自動的にビルドできます。オンボーディング後、通常はポート **18789** で Gateway を実行します。

ソースから（コントリビューター/Dev の場合）:

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
pnpm install
pnpm build
pnpm ui:build # 初回実行時に UI 依存関係を自動インストール
openclaw onboard
```

グローバルインストールがない場合は `pnpm openclaw onboard` 経由で実行してください。

### オンボーディング後にダッシュボードを開くには？

ウィザードはオンボーディング直後に、クリーンな（トークンなしの）ダッシュボード URL でブラウザを開き、サマリーにもリンクを表示します。そのタブを開いたままにしてください。起動しなかった場合は、同じマシンで表示されたURLをコピー&ペーストしてください。

### localhost とリモートでダッシュボードのトークン認証をするには？

**Localhost（同じマシン）:**

- `http://127.0.0.1:18789/` を開きます。
- 認証を求められた場合は、`gateway.auth.token`（または `OPENCLAW_GATEWAY_TOKEN`）のトークンを Control UI の設定に貼り付けます。
- Gateway ホストから取得します: `openclaw config get gateway.auth.token`（または生成します: `openclaw doctor --generate-gateway-token`）。

**localhost 以外の場合:**

- **Tailscale Serve**（推奨）: bind をループバックのままにし、`openclaw gateway --tailscale serve` を実行して、`https://<magicdns>/` を開きます。`gateway.auth.allowTailscale` が `true` の場合、Identity ヘッダーが Control UI/WebSocket 認証を満たします（トークン不要、Gateway ホストが信頼されると想定）。HTTP API にはトークン/パスワードが引き続き必要です。
- **Tailnet バインド**: `openclaw gateway --bind tailnet --token "<token>"` を実行し、`http://<tailscale-ip>:18789/` を開き、ダッシュボード設定にトークンを貼り付けます。
- **SSH トンネル**: `ssh -N -L 18789:127.0.0.1:18789 user@host`、次に `http://127.0.0.1:18789/` を開き、Control UI 設定にトークンを貼り付けます。

バインドモードと認証の詳細については [ダッシュボード](/web/dashboard) と [Web サーフェス](/web) を参照してください。

### 必要なランタイムは？

Node **>= 22** が必要です。`pnpm` が推奨されます。Bun は Gateway には**推奨しません**。

### Raspberry Pi で動作しますか？

はい。Gateway は軽量です。ドキュメントには個人使用に十分なスペックとして **512MB〜1GB RAM**、**1 コア**、約 **500MB** のディスクが記載されており、**Raspberry Pi 4 で実行できる**と述べられています。

余裕が欲しい場合（ログ、メディア、その他のサービス）、**2GB が推奨**されますが、ハードな最小値ではありません。

ヒント: 小さな Pi/VPS で Gateway をホストし、ラップトップ/スマートフォンで**ノード**をペアリングして、ローカルのスクリーン/カメラ/キャンバスまたはコマンド実行を利用できます。[ノード](/nodes) を参照してください。

### Raspberry Pi インストールのヒントは？

簡単に言うと: 動作しますが、粗削りな部分があることを想定してください。

- **64 ビット** OS を使用し、Node >= 22 を維持してください。
- ログを確認して素早く更新できるように、**ハッカブル（git）インストール**をお勧めします。
- チャンネル/スキルなしで始め、一つずつ追加してください。
- 奇妙なバイナリの問題が発生した場合は、通常 **ARM 互換性**の問題です。

ドキュメント: [Linux](/platforms/linux)、[インストール](/install)。

### 「wake up my friend」で詰まる / オンボーディングが進まない。どうすれば？

この画面は Gateway が到達可能で認証済みであることに依存しています。TUI は最初のハッチ時に「Wake up, my friend!」を自動的に送信します。返信がなく、トークンが 0 のままの場合、エージェントは実行されませんでした。

1. Gateway を再起動します:

```bash
openclaw gateway restart
```

2. ステータスと認証を確認します:

```bash
openclaw status
openclaw models status
openclaw logs --follow
```

3. まだハングする場合は:

```bash
openclaw doctor
```

Gateway がリモートの場合は、トンネル/Tailscale 接続が確立されていること、UI が正しい Gateway を指していることを確認してください。[リモートアクセス](/gateway/remote) を参照してください。

### オンボーディングをやり直さずに新しいマシン（Mac mini）にセットアップを移行できますか？

はい。**状態ディレクトリ**と**ワークスペース**をコピーし、Doctor を一度実行してください。**両方**の場所をコピーする限り、ボットは（メモリ、セッション履歴、認証、チャンネル状態を含めて）「まったく同じ」状態を維持します:

1. 新しいマシンに OpenClaw をインストールします。
2. 古いマシンから `$OPENCLAW_STATE_DIR`（デフォルト: `~/.openclaw`）をコピーします。
3. ワークスペース（デフォルト: `~/.openclaw/workspace`）をコピーします。
4. `openclaw doctor` を実行して Gateway サービスを再起動します。

これにより設定、認証プロファイル、WhatsApp のクレデンシャル、セッション、メモリが保持されます。リモートモードの場合、Gateway ホストがセッションストアとワークスペースを所有することを覚えておいてください。

**重要:** ワークスペースのみを GitHub にコミット/プッシュする場合、**メモリ + ブートストラップファイル**はバックアップされますが、セッション履歴や認証は**されません**。これらは `~/.openclaw/` 以下にあります（例: `~/.openclaw/agents/<agentId>/sessions/`）。

関連: [移行](/install/migrating)、[ディスク上のデータの場所](/help/faq#where-does-openclaw-store-its-data)、
[エージェントワークスペース](/concepts/agent-workspace)、[Doctor](/gateway/doctor)、
[リモートモード](/gateway/remote)。

### 最新バージョンの変更点はどこで確認できますか？

GitHub の変更履歴を確認してください:
[https://github.com/openclaw/openclaw/blob/main/CHANGELOG.md](https://github.com/openclaw/openclaw/blob/main/CHANGELOG.md)

最新エントリーが先頭にあります。先頭セクションが **Unreleased** とマークされている場合、次の日付付きセクションが最新のリリースバージョンです。エントリは **Highlights**、**Changes**、**Fixes** でグループ化されています（必要に応じてドキュメント/その他のセクションも）。

### docs.openclaw.ai にアクセスできない（SSL エラー）。どうすれば？

一部の Comcast/Xfinity 接続では、Xfinity Advanced Security によって `docs.openclaw.ai` が誤ってブロックされます。無効にするか `docs.openclaw.ai` を許可リストに追加し、再試行してください。詳細: [トラブルシューティング](/help/troubleshooting#docsopenclawai-shows-an-ssl-error-comcastxfinity)。
こちらで報告してブロック解除にご協力ください: [https://spa.xfinity.com/check_url_status](https://spa.xfinity.com/check_url_status)。

まだサイトに到達できない場合は、ドキュメントは GitHub にミラーされています:
[https://github.com/openclaw/openclaw/tree/main/docs](https://github.com/openclaw/openclaw/tree/main/docs)

### stable と beta の違いは？

**Stable** と **beta** は **npm のディストリビューションタグ**であり、別のコードラインではありません:

- `latest` = stable
- `beta` = テスト用の早期ビルド

ビルドを **beta** にリリースし、テストして、ビルドが安定したら**同じバージョンを `latest` に昇格**させます。そのため、beta と stable が**同じバージョン**を指す場合があります。

変更点を確認:
[https://github.com/openclaw/openclaw/blob/main/CHANGELOG.md](https://github.com/openclaw/openclaw/blob/main/CHANGELOG.md)

### beta バージョンのインストール方法と、beta と dev の違いは？

**Beta** は npm のディストリビューションタグ `beta`（`latest` と一致する場合があります）。
**Dev** は `main` の移動するヘッド（git）。公開される場合は npm ディストリビューションタグ `dev` を使用します。

ワンライナー（macOS/Linux）:

```bash
curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash -s -- --beta
```

```bash
curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash -s -- --install-method git
```

Windows インストーラー（PowerShell）:
[https://openclaw.ai/install.ps1](https://openclaw.ai/install.ps1)

詳細: [開発チャンネル](/install/development-channels) と [インストーラーフラグ](/install/installer)。

### インストールとオンボーディングにかかる時間は？

目安:

- **インストール:** 2〜5 分
- **オンボーディング:** 設定するチャンネル/モデルの数によって 5〜15 分

ハングする場合は [インストーラーが詰まった](/help/faq#installer-stuck-how-do-i-get-more-feedback) と [詰まっています](/help/faq#im-stuck--whats-the-fastest-way-to-get-unstuck) のクイックデバッグループを使用してください。

### 最新ビットを試すには？

2 つのオプション:

1. **Dev チャンネル（git チェックアウト）:**

```bash
openclaw update --channel dev
```

`main` ブランチに切り替えてソースから更新します。

2. **ハッカブルインストール（インストーラーサイトから）:**

```bash
curl -fsSL https://openclaw.ai/install.sh | bash -s -- --install-method git
```

これにより編集可能なローカルリポジトリが作成され、git 経由で更新できます。

手動でクリーンクローンを希望する場合:

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
pnpm install
pnpm build
```

ドキュメント: [更新](/cli/update)、[開発チャンネル](/install/development-channels)、
[インストール](/install)。

### インストーラーが詰まった。詳細情報を取得するには？

**詳細出力**でインストーラーを再実行してください:

```bash
curl -fsSL https://openclaw.ai/install.sh | bash -s -- --verbose
```

詳細付き beta インストール:

```bash
curl -fsSL https://openclaw.ai/install.sh | bash -s -- --beta --verbose
```

ハッカブル（git）インストールの場合:

```bash
curl -fsSL https://openclaw.ai/install.sh | bash -s -- --install-method git --verbose
```

Windows（PowerShell）の同等:

```powershell
# install.ps1 には専用の -Verbose フラグはまだありません。
Set-PSDebug -Trace 1
& ([scriptblock]::Create((iwr -useb https://openclaw.ai/install.ps1))) -NoOnboard
Set-PSDebug -Trace 0
```

その他のオプション: [インストーラーフラグ](/install/installer)。

### Windows インストールで git が見つからない、または openclaw が認識されない

よくある 2 つの Windows の問題:

**1) npm error spawn git / git not found**

- **Git for Windows** をインストールして、`git` が PATH に含まれていることを確認してください。
- PowerShell を閉じて再度開き、インストーラーを再実行してください。

**2) インストール後に openclaw が認識されない**

- npm のグローバル bin フォルダーが PATH に含まれていません。
- パスを確認してください:

  ```powershell
  npm config get prefix
  ```

- `<prefix>\\bin` が PATH にあることを確認してください（多くのシステムでは `%AppData%\\npm`）。
- PATH を更新した後、PowerShell を閉じて再度開いてください。

最もスムーズな Windows セットアップが必要な場合は、ネイティブ Windows の代わりに **WSL2** を使用してください。
ドキュメント: [Windows](/platforms/windows)。

### ドキュメントで質問の答えが見つからない。より良い答えを得るには？

**ハッカブル（git）インストール**を使用してローカルにフルソースとドキュメントを用意し、そのフォルダーからボット（または Claude/Codex）に質問してください。そうすることでリポジトリを読んで正確に答えられます。

```bash
curl -fsSL https://openclaw.ai/install.sh | bash -s -- --install-method git
```

詳細: [インストール](/install) と [インストーラーフラグ](/install/installer)。

### Linux に OpenClaw をインストールするには？

簡単に言うと: Linux ガイドに従い、オンボーディングウィザードを実行してください。

- Linux クイックパス + サービスインストール: [Linux](/platforms/linux)。
- 完全なウォークスルー: [はじめに](/start/getting-started)。
- インストーラーと更新: [インストールと更新](/install/updating)。

### VPS に OpenClaw をインストールするには？

どの Linux VPS でも動作します。サーバーにインストールし、SSH/Tailscale で Gateway にアクセスします。

ガイド: [exe.dev](/install/exe-dev)、[Hetzner](/install/hetzner)、[Fly.io](/install/fly)。
リモートアクセス: [Gateway リモート](/gateway/remote)。

### クラウド/VPS インストールガイドはどこにありますか？

一般的なプロバイダーの**ホスティングハブ**があります。1 つを選んでガイドに従ってください:

- [VPS ホスティング](/vps)（すべてのプロバイダーが 1 か所に）
- [Fly.io](/install/fly)
- [Hetzner](/install/hetzner)
- [exe.dev](/install/exe-dev)

クラウドでの仕組み: **Gateway はサーバーで実行**し、Control UI（または Tailscale/SSH）経由でラップトップ/スマートフォンからアクセスします。状態 + ワークスペースはサーバーに保存されるので、ホストを信頼できるソースとして扱い、バックアップしてください。

クラウド Gateway に**ノード**（Mac/iOS/Android/ヘッドレス）をペアリングして、Gateway をクラウドに保ちながらラップトップのローカルスクリーン/カメラ/キャンバスやコマンド実行にアクセスできます。

ハブ: [プラットフォーム](/platforms)。リモートアクセス: [Gateway リモート](/gateway/remote)。
ノード: [ノード](/nodes)、[ノード CLI](/cli/nodes)。

### OpenClaw に自己更新を依頼できますか？

簡単に言うと: **可能ですが推奨しません**。更新フローにより Gateway が再起動（アクティブセッションが切断）し、クリーンな git チェックアウトが必要になる場合があり、確認を求めることがあります。より安全: シェルからオペレーターとして更新を実行してください。

CLI を使用してください:

```bash
openclaw update
openclaw update status
openclaw update --channel stable|beta|dev
openclaw update --tag <dist-tag|version>
openclaw update --no-restart
```

エージェントから自動化する必要がある場合:

```bash
openclaw update --yes --no-restart
openclaw gateway restart
```

ドキュメント: [更新](/cli/update)、[更新](/install/updating)。

### オンボーディングウィザードは実際に何をしますか？

`openclaw onboard` は推奨されるセットアップパスです。**ローカルモード**では以下を案内します:

- **モデル/認証セットアップ**（Claude サブスクリプションには Anthropic **setup-token** が推奨、OpenAI Codex OAuth サポート、API キーはオプション、LM Studio ローカルモデルをサポート）
- **ワークスペース**の場所 + ブートストラップファイル
- **Gateway 設定**（バインド/ポート/認証/tailscale）
- **プロバイダー**（WhatsApp、Telegram、Discord、Mattermost（プラグイン）、Signal、iMessage）
- **デーモンインストール**（macOS では LaunchAgent、Linux/WSL2 では systemd ユーザーユニット）
- **ヘルスチェック**と**スキル**の選択

設定されたモデルが不明または認証が欠落している場合も警告します。

### 実行するために Claude または OpenAI のサブスクリプションが必要ですか？

いいえ。OpenClaw は **API キー**（Anthropic/OpenAI/その他）または**ローカルのみのモデル**で実行できるため、データはデバイス上に残ります。サブスクリプション（Claude Pro/Max または OpenAI Codex）は、これらのプロバイダーを認証するオプションの方法です。

ドキュメント: [Anthropic](/providers/anthropic)、[OpenAI](/providers/openai)、
[ローカルモデル](/gateway/local-models)、[モデル](/concepts/models)。

### API キーなしで Claude Max サブスクリプションを使用できますか？

はい。API キーの代わりに **setup-token** で認証できます。これがサブスクリプションのパスです。

Claude Pro/Max サブスクリプションには **API キーは含まれていない**ため、これがサブスクリプションアカウントの正しいアプローチです。重要: この使用方法が Anthropic のサブスクリプションポリシーと規約の下で許可されていることを Anthropic に確認する必要があります。最も明確でサポートされるパスが必要な場合は、Anthropic API キーを使用してください。

### Anthropic の「setup-token」認証はどのように機能しますか？

`claude setup-token` は Claude Code CLI 経由で**トークン文字列**を生成します（Web コンソールでは利用できません）。**どのマシンでも**実行できます。ウィザードで「Anthropic token (paste setup-token)」を選択するか、`openclaw models auth paste-token --provider anthropic` で貼り付けてください。トークンは **anthropic** プロバイダーの認証プロファイルとして保存され、API キーのように使用されます（自動更新なし）。詳細: [OAuth](/concepts/oauth)。

### Anthropic の setup-token はどこで入手できますか？

Anthropic Console には**ありません**。setup-token は**どのマシン**の **Claude Code CLI** で生成されます:

```bash
claude setup-token
```

表示されたトークンをコピーし、ウィザードで「Anthropic token (paste setup-token)」を選択してください。Gateway ホストで実行したい場合は `openclaw models auth setup-token --provider anthropic` を使用してください。別の場所で `claude setup-token` を実行した場合は、Gateway ホストで `openclaw models auth paste-token --provider anthropic` で貼り付けてください。[Anthropic](/providers/anthropic) を参照してください。

### Claude サブスクリプション認証（Claude Pro または Max）をサポートしていますか？

はい。**setup-token** 経由で。OpenClaw は Claude Code CLI の OAuth トークンを再利用しなくなりました。setup-token または Anthropic API キーを使用してください。どこでもトークンを生成し、Gateway ホストに貼り付けてください。[Anthropic](/providers/anthropic) と [OAuth](/concepts/oauth) を参照してください。

注意: Claude サブスクリプションアクセスは Anthropic の規約に従います。本番または複数ユーザーのワークロードには、通常 API キーの方が安全です。

### Anthropic から `HTTP 429: rate_limit_error` が表示されるのはなぜですか？

これは、現在のウィンドウで **Anthropic のクォータ/レート制限**が使い果たされたことを意味します。**Claude サブスクリプション**（setup-token または Claude Code OAuth）を使用している場合は、ウィンドウがリセットされるまで待つか、プランをアップグレードしてください。**Anthropic API キー**を使用している場合は、Anthropic Console で使用状況/請求を確認し、必要に応じて制限を引き上げてください。

ヒント: プロバイダーがレート制限されている間も OpenClaw が返信し続けられるように、**フォールバックモデル**を設定してください。
[モデル](/cli/models) と [OAuth](/concepts/oauth) を参照してください。

### AWS Bedrock はサポートされていますか？

はい。pi-ai の **Amazon Bedrock（Converse）**プロバイダーを使用した**手動設定**で。Gateway ホストに AWS クレデンシャル/リージョンを提供し、モデル設定に Bedrock プロバイダーエントリーを追加する必要があります。[Amazon Bedrock](/providers/bedrock) と [モデルプロバイダー](/providers/models) を参照してください。マネージドキーフローを好む場合は、Bedrock の前の OpenAI 互換プロキシも有効なオプションです。

### Codex 認証はどのように機能しますか？

OpenClaw は OAuth（ChatGPT サインイン）経由で **OpenAI Code（Codex）**をサポートしています。ウィザードは OAuth フローを実行でき、適切な場合にデフォルトモデルを `openai-codex/gpt-5.3-codex` に設定します。[モデルプロバイダー](/concepts/model-providers) と [ウィザード](/start/wizard) を参照してください。

### OpenAI サブスクリプション認証（Codex OAuth）をサポートしていますか？

はい。OpenClaw は **OpenAI Code（Codex）サブスクリプション OAuth** を完全にサポートしています。オンボーディングウィザードが OAuth フローを実行できます。

[OAuth](/concepts/oauth)、[モデルプロバイダー](/concepts/model-providers)、[ウィザード](/start/wizard) を参照してください。

### Gemini CLI OAuth をセットアップするには？

Gemini CLI は `openclaw.json` のクライアント ID やシークレットではなく、**プラグイン認証フロー**を使用します。

手順:

1. プラグインを有効にします: `openclaw plugins enable google-gemini-cli-auth`
2. ログインします: `openclaw models auth login --provider google-gemini-cli --set-default`

これにより OAuth トークンが Gateway ホストの認証プロファイルに保存されます。詳細: [モデルプロバイダー](/concepts/model-providers)。

### カジュアルなチャットにローカルモデルは適していますか？

通常はいいえ。OpenClaw には大きなコンテキストと強力な安全性が必要です。小さなモデルは切り捨てや漏洩が発生します。使用する必要がある場合は、最大の MiniMax M2.1 ビルドをローカルで実行し（LM Studio）、[/gateway/local-models](/gateway/local-models) を参照してください。小さな/量子化されたモデルはプロンプトインジェクションのリスクが増加します。[セキュリティ](/gateway/security) を参照してください。

### ホスト型モデルのトラフィックを特定のリージョンに保つには？

リージョン固定のエンドポイントを選択してください。OpenRouter は MiniMax、Kimi、GLM の米国ホスト型オプションを公開しています。データをリージョン内に保つために米国ホスト型バリアントを選択してください。`models.mode: "merge"` を使用して Anthropic/OpenAI を並べてリストアップすることもできます。これにより、選択したリージョン固定プロバイダーを尊重しながらフォールバックが利用可能になります。

### インストールするために Mac mini を購入する必要がありますか？

いいえ。OpenClaw は macOS または Linux（Windows は WSL2 経由）で動作します。Mac mini はオプションです。常時稼働のホストとして購入する方もいますが、小さな VPS、ホームサーバー、または Raspberry Pi クラスのボックスも動作します。

**macOS 専用ツール**にのみ Mac が必要です。iMessage には [BlueBubbles](/channels/bluebubbles)（推奨）を使用してください。BlueBubbles サーバーはどの Mac でも動作し、Gateway は Linux またはその他の場所で実行できます。その他の macOS 専用ツールが必要な場合は、Mac で Gateway を実行するか、macOS ノードをペアリングしてください。

ドキュメント: [BlueBubbles](/channels/bluebubbles)、[ノード](/nodes)、[Mac リモートモード](/platforms/mac/remote)。

### iMessage サポートに Mac mini が必要ですか？

Messages にサインインした**何らかの macOS デバイス**が必要です。Mac mini である必要は**ありません**。どの Mac でも動作します。iMessage には **[BlueBubbles](/channels/bluebubbles) を使用**（推奨）してください。BlueBubbles サーバーは macOS で動作し、Gateway は Linux またはその他の場所で実行できます。

一般的なセットアップ:

- Linux/VPS で Gateway を実行し、Messages にサインインした任意の Mac で BlueBubbles サーバーを実行する。
- 最もシンプルなシングルマシンセットアップが必要な場合はすべてを Mac で実行する。

ドキュメント: [BlueBubbles](/channels/bluebubbles)、[ノード](/nodes)、
[Mac リモートモード](/platforms/mac/remote)。

### OpenClaw を実行するために Mac mini を購入した場合、MacBook Pro に接続できますか？

はい。**Mac mini で Gateway を実行**し、MacBook Pro を**ノード**（コンパニオンデバイス）として接続できます。ノードは Gateway を実行しません。そのデバイスでスクリーン/カメラ/キャンバスや `system.run` などの追加ケイパビリティを提供します。

一般的なパターン:

- Gateway を Mac mini で実行（常時稼働）。
- MacBook Pro は macOS アプリまたはノードホストを実行し、Gateway にペアリングします。
- `openclaw nodes status` / `openclaw nodes list` で確認できます。

ドキュメント: [ノード](/nodes)、[ノード CLI](/cli/nodes)。

### Bun を使用できますか？

Bun は**推奨しません**。特に WhatsApp と Telegram でランタイムバグが見られます。
安定した Gateway には **Node** を使用してください。

それでも Bun を試したい場合は、WhatsApp/Telegram なしの非本番 Gateway で行ってください。

### Telegram: `allowFrom` には何を入れますか？

`channels.telegram.allowFrom` は**人間の送信者の Telegram ユーザー ID**（数値）です。ボットのユーザー名ではありません。

オンボーディングウィザードは `@username` 入力を受け付けて数値 ID に解決しますが、OpenClaw の認証は数値 ID のみを使用します。

より安全な方法（サードパーティのボットなし）:

- ボットに DM し、`openclaw logs --follow` を実行して `from.id` を読み取ります。

公式 Bot API:

- ボットに DM し、`https://api.telegram.org/bot<bot_token>/getUpdates` を呼び出して `message.from.id` を読み取ります。

サードパーティ（プライバシーが低い）:

- `@userinfobot` または `@getidsbot` に DM します。

[/channels/telegram](/channels/telegram#access-control-dms--groups) を参照してください。

### 複数のユーザーが 1 つの WhatsApp 番号を異なる OpenClaw インスタンスで使用できますか？

はい。**マルチエージェントルーティング**経由で。各送信者の WhatsApp **DM**（ピア `kind: "direct"`、送信者 E.164 形式 `+15551234567`）を異なる `agentId` にバインドし、各ユーザーが独自のワークスペースとセッションストアを持てるようにします。返信は同じ **WhatsApp アカウント**から来て、DM アクセス制御（`channels.whatsapp.dmPolicy` / `channels.whatsapp.allowFrom`）は WhatsApp アカウントごとにグローバルです。[マルチエージェントルーティング](/concepts/multi-agent) と [WhatsApp](/channels/whatsapp) を参照してください。

### 「高速チャット」エージェントと「コーディング用 Opus」エージェントを実行できますか？

はい。マルチエージェントルーティングを使用して: 各エージェントに独自のデフォルトモデルを設定し、受信ルート（プロバイダーアカウントまたは特定のピア）を各エージェントにバインドします。設定例は [マルチエージェントルーティング](/concepts/multi-agent) にあります。[モデル](/concepts/models) と [設定](/gateway/configuration) も参照してください。

### Homebrew は Linux で動作しますか？

はい。Homebrew は Linux（Linuxbrew）をサポートしています。クイックセットアップ:

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
echo 'eval "$(/home/linuxbrew/.linuxbrew/bin/brew shellenv)"' >> ~/.profile
eval "$(/home/linuxbrew/.linuxbrew/bin/brew shellenv)"
brew install <formula>
```

systemd で OpenClaw を実行する場合は、`brew` インストールのツールが非ログインシェルで解決できるように、サービスの PATH に `/home/linuxbrew/.linuxbrew/bin`（またはあなたの brew プレフィックス）が含まれていることを確認してください。
最近のビルドは Linux systemd サービスで一般的なユーザー bin ディレクトリ（例: `~/.local/bin`、`~/.npm-global/bin`、`~/.local/share/pnpm`、`~/.bun/bin`）を先頭に追加し、`PNPM_HOME`、`NPM_CONFIG_PREFIX`、`BUN_INSTALL`、`VOLTA_HOME`、`ASDF_DATA_DIR`、`NVM_DIR`、`FNM_DIR` が設定されている場合はそれらも考慮します。

### ハッカブル（git）インストールと npm インストールの違いは？

- **ハッカブル（git）インストール:** 完全なソースチェックアウト、編集可能、コントリビューターに最適。
  ビルドをローカルで実行し、コード/ドキュメントにパッチを当てられます。
- **npm インストール:** グローバル CLI インストール、リポジトリなし、「とにかく実行する」に最適。
  更新は npm のディストリビューションタグから来ます。

ドキュメント: [はじめに](/start/getting-started)、[更新](/install/updating)。

### 後で npm インストールと git インストールを切り替えられますか？

はい。もう一方のフレーバーをインストールし、Doctor を実行して Gateway サービスが新しいエントリーポイントを指すようにしてください。
これにより**データは削除されません**。OpenClaw コードのインストールが変更されるだけです。状態
（`~/.openclaw`）とワークスペース（`~/.openclaw/workspace`）は変更されません。

npm → git:

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
pnpm install
pnpm build
openclaw doctor
openclaw gateway restart
```

git → npm:

```bash
npm install -g openclaw@latest
openclaw doctor
openclaw gateway restart
```

Doctor は Gateway サービスのエントリーポイントの不一致を検出し、現在のインストールに合わせてサービス設定を書き換えることを提案します（自動化では `--repair` を使用）。

バックアップのヒント: [バックアップ戦略](/help/faq#whats-the-recommended-backup-strategy) を参照してください。

### Gateway はラップトップと VPS のどちらで実行すべきですか？

簡単に言うと: **24/7 の信頼性が必要な場合は VPS を使用**してください。スリープ/再起動が許容できる場合はローカルで実行してください。

**ラップトップ（ローカル Gateway）**

- **長所:** サーバーコストなし、ローカルファイルへの直接アクセス、ライブブラウザウィンドウ。
- **短所:** スリープ/ネットワーク切断 = 接続切断、OS 更新/再起動で中断、常に起動していなければならない。

**VPS / クラウド**

- **長所:** 常時稼働、安定したネットワーク、ラップトップのスリープ問題なし、実行し続けやすい。
- **短所:** 多くの場合ヘッドレスで実行（スクリーンショットを使用）、リモートファイルアクセスのみ、更新には SSH が必要。

**OpenClaw 固有の注意:** WhatsApp/Telegram/Slack/Mattermost（プラグイン）/Discord はすべて VPS から問題なく動作します。実際のトレードオフは**ヘッドレスブラウザ**対可視ウィンドウです。[ブラウザ](/tools/browser) を参照してください。

**推奨デフォルト:** 以前 Gateway の切断が発生していた場合は VPS。Mac をアクティブに使用していて、ローカルファイルアクセスや可視ブラウザでの UI 自動化が必要な場合はローカルが最適です。

### OpenClaw を専用マシンで実行することはどの程度重要ですか？

必須ではありませんが、**信頼性と分離のために推奨**されます。

- **専用ホスト（VPS/Mac mini/Pi）:** 常時稼働、スリープ/再起動の中断が少ない、クリーンなパーミッション、実行し続けやすい。
- **共有ラップトップ/デスクトップ:** テストやアクティブな使用には問題ありませんが、マシンのスリープや更新時に一時停止が発生することを想定してください。

両方の良いところを取りたい場合は、Gateway を専用ホストに置き、ラップトップをローカルのスクリーン/カメラ/exec ツール用の**ノード**としてペアリングしてください。[ノード](/nodes) を参照してください。
セキュリティガイダンスは [セキュリティ](/gateway/security) を参照してください。

### VPS の最小要件と推奨 OS は？

OpenClaw は軽量です。基本的な Gateway + 1 つのチャットチャンネルの場合:

- **絶対最小:** 1 vCPU、1GB RAM、約 500MB ディスク。
- **推奨:** 1〜2 vCPU、余裕のために 2GB 以上の RAM（ログ、メディア、複数チャンネル）。ノードツールとブラウザ自動化はリソースを多く消費する可能性があります。

OS: **Ubuntu LTS**（または最新の Debian/Ubuntu）を使用してください。Linux インストールパスはそこで最もテストされています。

ドキュメント: [Linux](/platforms/linux)、[VPS ホスティング](/vps)。

### VM で OpenClaw を実行できますか？要件は何ですか？

はい。VM を VPS と同じように扱ってください。常時稼働、到達可能で、Gateway と有効にするチャンネルに十分な RAM が必要です。

ベースラインガイダンス:

- **絶対最小:** 1 vCPU、1GB RAM。
- **推奨:** 複数チャンネル、ブラウザ自動化、またはメディアツールを実行する場合は 2GB 以上の RAM。
- **OS:** Ubuntu LTS または別の最新 Debian/Ubuntu。

Windows を使用している場合、**WSL2 が最も簡単な VM スタイルのセットアップ**であり、ツールの互換性が最も高いです。[Windows](/platforms/windows)、[VPS ホスティング](/vps) を参照してください。
macOS を VM で実行している場合は [macOS VM](/install/macos-vm) を参照してください。


## OpenClaw とは？

### OpenClaw を 1 段落で説明すると？

OpenClaw は自分のデバイスで実行するパーソナル AI アシスタントです。すでに使用しているメッセージングサーフェス（WhatsApp、Telegram、Slack、Mattermost（プラグイン）、Discord、Google Chat、Signal、iMessage、WebChat）で返信し、サポートされているプラットフォームでは音声 + ライブキャンバスも利用できます。**Gateway** は常時稼働のコントロールプレーンで、アシスタントが製品です。

### 価値提案は？

OpenClaw は「単なる Claude のラッパー」ではありません。**自分のハードウェア**で有能なアシスタントを実行し、すでに使用しているチャットアプリから到達でき、ホスト型 SaaS にワークフローのコントロールを渡すことなく、ステートフルなセッション、メモリ、ツールを持つ**ローカルファーストのコントロールプレーン**です。

ハイライト:

- **自分のデバイス、自分のデータ:** 好きな場所（Mac、Linux、VPS）で Gateway を実行し、ワークスペース + セッション履歴をローカルに保持。
- **リアルなチャンネル、Web サンドボックスではない:** WhatsApp/Telegram/Slack/Discord/Signal/iMessage など、サポートされているプラットフォームでのモバイル音声とキャンバス。
- **モデル非依存:** Anthropic、OpenAI、MiniMax、OpenRouter などを使用し、エージェントごとのルーティングとフェイルオーバー。
- **ローカルのみオプション:** ローカルモデルを実行することで、**すべてのデータをデバイス上に保持**できます。
- **マルチエージェントルーティング:** チャンネル、アカウント、またはタスクごとに別々のエージェントを持ち、それぞれ独自のワークスペースとデフォルト。
- **オープンソースとハッカブル:** ベンダーロックインなしで検査、拡張、セルフホスト。

ドキュメント: [Gateway](/gateway)、[チャンネル](/channels)、[マルチエージェント](/concepts/multi-agent)、
[メモリ](/concepts/memory)。

### セットアップしました。最初に何をすべきですか？

最初に試すと良いプロジェクト:

- ウェブサイトを構築する（WordPress、Shopify、またはシンプルな静的サイト）。
- モバイルアプリをプロトタイプする（概要、画面、API 計画）。
- ファイルとフォルダーを整理する（クリーンアップ、命名、タグ付け）。
- Gmail を接続してサマリーやフォローアップを自動化する。

大きなタスクも処理できますが、フェーズに分割して並行作業にサブエージェントを使用すると最も効果的です。

### OpenClaw の日常的なユースケース上位 5 つは？

日常的な活用例:

- **パーソナルブリーフィング:** 受信トレイ、カレンダー、関心のあるニュースのサマリー。
- **リサーチと草稿作成:** クイックリサーチ、サマリー、メールやドキュメントの初稿。
- **リマインダーとフォローアップ:** Cron またはハートビート駆動のナッジとチェックリスト。
- **ブラウザ自動化:** フォームへの記入、データ収集、Web タスクの繰り返し。
- **クロスデバイスコーディネーション:** スマートフォンからタスクを送り、Gateway がサーバーで実行し、結果をチャットで受け取る。

### OpenClaw は SaaS のリードジェン、アウトリーチ、広告、ブログを支援できますか？

**リサーチ、資格確認、草稿作成**については はい。サイトをスキャンし、ショートリストを作成し、見込み客を要約し、アウトリーチや広告コピーの草稿を書けます。

**アウトリーチや広告の実行**については、人間が監督に関与してください。スパムを避け、現地の法律とプラットフォームポリシーに従い、送信前にすべてをレビューしてください。最も安全なパターンは OpenClaw が草稿を作成し、あなたが承認することです。

ドキュメント: [セキュリティ](/gateway/security)。

### Web 開発における Claude Code との比較での利点は？

OpenClaw は**パーソナルアシスタント**とコーディネーションレイヤーであり、IDE の代替ではありません。リポジトリ内での最速の直接コーディングループには Claude Code または Codex を使用してください。持続的なメモリ、クロスデバイスアクセス、ツールオーケストレーションが必要な場合は OpenClaw を使用してください。

利点:

- **セッションをまたいだ持続的なメモリ + ワークスペース**
- **マルチプラットフォームアクセス**（WhatsApp、Telegram、TUI、WebChat）
- **ツールオーケストレーション**（ブラウザ、ファイル、スケジューリング、フック）
- **常時稼働の Gateway**（VPS で実行し、どこからでも対話）
- ローカルブラウザ/スクリーン/カメラ/exec 用の**ノード**

ショーケース: [https://openclaw.ai/showcase](https://openclaw.ai/showcase)

## スキルとオートメーション

### リポジトリを汚さずにスキルをカスタマイズするには？

リポジトリのコピーを編集する代わりに管理されたオーバーライドを使用してください。変更を `~/.openclaw/skills/<name>/SKILL.md` に置くか（または `~/.openclaw/openclaw.json` の `skills.load.extraDirs` でフォルダーを追加）。優先順位は `<workspace>/skills` > `~/.openclaw/skills` > バンドル済みなので、git に触れずに管理されたオーバーライドが優先されます。アップストリームに値する編集のみがリポジトリに存在し、PR として送られるべきです。

### カスタムフォルダーからスキルを読み込めますか？

はい。`~/.openclaw/openclaw.json` の `skills.load.extraDirs` で追加ディレクトリを追加します（最低優先度）。デフォルトの優先順位は変わりません: `<workspace>/skills` → `~/.openclaw/skills` → バンドル済み → `skills.load.extraDirs`。`clawhub` はデフォルトで `./skills` にインストールします。OpenClaw はこれを次のセッションで `<workspace>/skills` として扱います。

### タスクごとに異なるモデルを使用するには？

現在サポートされているパターン:

- **Cron ジョブ**: 分離されたジョブはジョブごとに `model` オーバーライドを設定できます。
- **サブエージェント**: タスクを異なるデフォルトモデルを持つ別々のエージェントにルーティングします。
- **オンデマンド切り替え**: `/model` を使用して現在のセッションモデルをいつでも切り替えます。

[Cron ジョブ](/automation/cron-jobs)、[マルチエージェントルーティング](/concepts/multi-agent)、[スラッシュコマンド](/tools/slash-commands) を参照してください。

### 重い作業中にボットがフリーズします。オフロードするには？

長いタスクや並行タスクには**サブエージェント**を使用してください。サブエージェントは独自のセッションで実行し、サマリーを返して、メインチャットをレスポンシブに保ちます。

ボットに「このタスクにサブエージェントを生成して」と依頼するか、`/subagents` を使用してください。
`/status` をチャットで使用して、Gateway が今何をしているか（ビジー状態かどうか）を確認してください。

トークンのヒント: 長いタスクとサブエージェントはどちらもトークンを消費します。コストが気になる場合は、`agents.defaults.subagents.model` でサブエージェントに安価なモデルを設定してください。

ドキュメント: [サブエージェント](/tools/subagents)。

### Cron またはリマインダーが発火しません。何を確認すべきですか？

Cron は Gateway プロセス内で実行されます。Gateway が継続的に実行されていない場合、スケジュールされたジョブは実行されません。

チェックリスト:

- Cron が有効（`cron.enabled`）で `OPENCLAW_SKIP_CRON` が設定されていないことを確認してください。
- Gateway が 24/7 実行中（スリープ/再起動なし）であることを確認してください。
- ジョブのタイムゾーン設定を確認してください（`--tz` vs ホストのタイムゾーン）。

デバッグ:

```bash
openclaw cron run <jobId> --force
openclaw cron runs --id <jobId> --limit 50
```

ドキュメント: [Cron ジョブ](/automation/cron-jobs)、[Cron vs ハートビート](/automation/cron-vs-heartbeat)。

### Linux にスキルをインストールするには？

**ClawHub**（CLI）を使用するか、ワークスペースにスキルをドロップしてください。macOS のスキル UI は Linux では利用できません。
スキルは [https://clawhub.com](https://clawhub.com) で閲覧できます。

ClawHub CLI をインストールします（パッケージマネージャーを選択）:

```bash
npm i -g clawhub
```

```bash
pnpm add -g clawhub
```

### OpenClaw はスケジュールでタスクを実行したり、バックグラウンドで継続的に実行できますか？

はい。Gateway スケジューラーを使用してください:

- **Cron ジョブ**（スケジュールまたは定期タスク（再起動をまたいで持続））。
- **ハートビート**（「メインセッション」の定期チェック）。
- **分離されたジョブ**（サマリーを投稿したり、チャットに配信する自律エージェント）。

ドキュメント: [Cron ジョブ](/automation/cron-jobs)、[Cron vs ハートビート](/automation/cron-vs-heartbeat)、
[ハートビート](/gateway/heartbeat)。

### Linux から Apple macOS 専用スキルを実行できますか？

直接はできません。macOS スキルは `metadata.openclaw.os` と必要なバイナリによってゲートされており、スキルは **Gateway ホスト**で適格な場合にのみシステムプロンプトに表示されます。Linux では、`darwin` 専用スキル（`apple-notes`、`apple-reminders`、`things-mac` など）はゲーティングをオーバーライドしない限り読み込まれません。

サポートされている 3 つのパターン:

**オプション A - Gateway を Mac で実行（最もシンプル）。**
macOS バイナリが存在する場所で Gateway を実行し、Linux から[リモートモード](#how-do-i-run-openclaw-in-remote-mode-client-connects-to-a-gateway-elsewhere)または Tailscale 経由で接続します。Gateway ホストが macOS であるため、スキルは通常通り読み込まれます。

**オプション B - macOS ノードを使用（SSH なし）。**
Linux で Gateway を実行し、macOS ノード（メニューバーアプリ）をペアリングし、Mac で Node Run Commands を「Always Ask」または「Always Allow」に設定します。必要なバイナリがノードに存在する場合、OpenClaw は macOS 専用スキルを適格として扱えます。エージェントは `nodes` ツール経由でこれらのスキルを実行します。「Always Ask」を選択した場合、プロンプトで「Always Allow」を承認するとそのコマンドが許可リストに追加されます。

**オプション C - SSH 経由で macOS バイナリをプロキシ（上級）。**
Linux で Gateway を維持しつつ、必要な CLI バイナリを Mac で実行する SSH ラッパーに解決させます。次に Linux を許可するようスキルをオーバーライドして適格のままにします。

1. バイナリ用の SSH ラッパーを作成します（例: Apple Notes の `memo`）:

   ```bash
   #!/usr/bin/env bash
   set -euo pipefail
   exec ssh -T user@mac-host /opt/homebrew/bin/memo "$@"
   ```

2. ラッパーを Linux ホストの `PATH` に置きます（例: `~/bin/memo`）。
3. Linux を許可するようスキルメタデータをオーバーライドします（ワークスペースまたは `~/.openclaw/skills`）:

   ```markdown
   ---
   name: apple-notes
   description: Manage Apple Notes via the memo CLI on macOS.
   metadata: { "openclaw": { "os": ["darwin", "linux"], "requires": { "bins": ["memo"] } } }
   ---
   ```

4. スキルスナップショットが更新されるように新しいセッションを開始します。

### Notion または HeyGen の統合はありますか？

現在はビルトインではありません。

オプション:

- **カスタムスキル / プラグイン:** 信頼性の高い API アクセスに最適（Notion/HeyGen はどちらも API を持っています）。
- **ブラウザ自動化:** コードなしで動作しますが、遅くて壊れやすいです。

クライアントごとのコンテキストを保持したい場合（エージェンシーワークフロー）、シンプルなパターンは:

- クライアントごとに 1 つの Notion ページ（コンテキスト + 好み + アクティブな作業）。
- セッション開始時にそのページを取得するようエージェントに依頼。

ネイティブ統合が必要な場合は、機能リクエストを開くか、それらの API をターゲットにしたスキルを構築してください。

スキルのインストール:

```bash
clawhub install <skill-slug>
clawhub update --all
```

ClawHub はデフォルトでカレントディレクトリの `./skills` にインストールします（または設定された OpenClaw ワークスペースにフォールバック）。OpenClaw は次のセッションでこれを `<workspace>/skills` として扱います。エージェント間で共有スキルの場合は `~/.openclaw/skills/<name>/SKILL.md` に置いてください。一部のスキルは Homebrew でインストールされたバイナリを必要とします。Linux では Linuxbrew を使用してください（上記の Homebrew Linux FAQ エントリーを参照）。[スキル](/tools/skills) と [ClawHub](/tools/clawhub) を参照してください。

### ブラウザ乗っ取り用の Chrome 拡張機能をインストールするには？

ビルトインインストーラーを使用して、Chrome にアンパックされた拡張機能を読み込んでください:

```bash
openclaw browser extension install
openclaw browser extension path
```

次に Chrome → `chrome://extensions` → 「デベロッパーモード」を有効化 → 「パッケージ化されていない拡張機能を読み込む」→ そのフォルダーを選択。

完全なガイド（リモート Gateway + セキュリティの注意事項を含む）: [Chrome 拡張機能](/tools/chrome-extension)

Gateway と Chrome が同じマシン（デフォルトのセットアップ）で実行されている場合は、通常追加の設定は**不要**です。
Gateway が別の場所で実行されている場合は、Gateway がブラウザアクションをプロキシできるように、ブラウザマシンでノードホストを実行してください。
コントロールしたいタブの拡張機能ボタンをクリックする必要があります（自動でアタッチされません）。

## サンドボックスとメモリ

### サンドボックス専用のドキュメントはありますか？

はい。[サンドボックス](/gateway/sandboxing) を参照してください。Docker 固有のセットアップ（Docker 内の完全な Gateway またはサンドボックスイメージ）については [Docker](/install/docker) を参照してください。

### サンドボックスにホストフォルダーをバインドするには？

`agents.defaults.sandbox.docker.binds` を `["host:path:mode"]`（例: `"/home/user/src:/src:ro"`）に設定します。グローバルとエージェントごとのバインドはマージされます。`scope: "shared"` の場合、エージェントごとのバインドは無視されます。機密性の高いものには `:ro` を使用し、バインドはサンドボックスのファイルシステムウォールをバイパスすることを覚えておいてください。例と安全に関する注意については [サンドボックス](/gateway/sandboxing#custom-bind-mounts) と [サンドボックス vs ツールポリシー vs 昇格](/gateway/sandbox-vs-tool-policy-vs-elevated#bind-mounts-security-quick-check) を参照してください。

### メモリはどのように機能しますか？

OpenClaw のメモリはエージェントワークスペース内の Markdown ファイルです:

- `memory/YYYY-MM-DD.md` の日次ノート
- `MEMORY.md` のキュレートされた長期ノート（メイン/プライベートセッションのみ）

OpenClaw はモデルに自動コンパクション前に持続的なノートを書くよう促すために**サイレントなプリコンパクションメモリフラッシュ**も実行します。これはワークスペースが書き込み可能な場合にのみ実行されます（読み取り専用サンドボックスはスキップ）。[メモリ](/concepts/memory) を参照してください。

### メモリが忘れ続けます。定着させるには？

ボットに**事実をメモリに書き込むよう**依頼してください。長期ノートは `MEMORY.md` に、短期コンテキストは `memory/YYYY-MM-DD.md` に。

これはまだ改善中の分野です。モデルにメモリを保存するよう促すと効果的です。それでも忘れる場合は、Gateway がすべての実行で同じワークスペースを使用していることを確認してください。

ドキュメント: [メモリ](/concepts/memory)、[エージェントワークスペース](/concepts/agent-workspace)。

### セマンティックメモリ検索に OpenAI API キーが必要ですか？

**OpenAI の埋め込み**を使用する場合のみ。Codex OAuth はチャット/補完をカバーし、埋め込みアクセスは**付与しません**。そのため、**Codex（OAuth または Codex CLI ログイン）でサインインすること**はセマンティックメモリ検索には役立ちません。OpenAI の埋め込みには実際の API キー（`OPENAI_API_KEY` または `models.providers.openai.apiKey`）が引き続き必要です。

プロバイダーを明示的に設定しない場合、OpenClaw は API キーを解決できる際に自動的にプロバイダーを選択します（認証プロファイル、`models.providers.*.apiKey`、または環境変数）。OpenAI キーが解決できれば OpenAI を優先し、そうでなければ Gemini キーが解決できれば Gemini、次に Voyage、次に Mistral を優先します。リモートキーが利用できない場合、設定するまでメモリ検索は無効のままです。ローカルモデルパスが設定されて存在する場合、OpenClaw は `local` を優先します。

ローカルにとどめたい場合は `memorySearch.provider = "local"` を設定します（オプションで `memorySearch.fallback = "none"`）。Gemini の埋め込みが必要な場合は `memorySearch.provider = "gemini"` を設定して `GEMINI_API_KEY`（または `memorySearch.remote.apiKey`）を提供してください。**OpenAI、Gemini、Voyage、Mistral、またはローカル**の埋め込みモデルをサポートしています。セットアップの詳細は [メモリ](/concepts/memory) を参照してください。

### メモリは永続しますか？制限は何ですか？

メモリファイルはディスクに保存され、削除するまで持続します。制限はモデルではなくストレージです。**セッションコンテキスト**はモデルのコンテキストウィンドウによって制限されるため、長い会話はコンパクトまたは切り捨てられる可能性があります。そのためメモリ検索が存在します。関連する部分のみをコンテキストに引き戻します。

ドキュメント: [メモリ](/concepts/memory)、[コンテキスト](/concepts/context)。

## ディスク上のデータの場所

### OpenClaw で使用されるすべてのデータはローカルに保存されますか？

いいえ。**OpenClaw の状態はローカル**ですが、**外部サービスは送信したものを見ます**。

- **デフォルトでローカル:** セッション、メモリファイル、設定、ワークスペースは Gateway ホスト（`~/.openclaw` + ワークスペースディレクトリ）に保存。
- **必要によりリモート:** モデルプロバイダー（Anthropic/OpenAI など）に送るメッセージはその API に送られ、チャットプラットフォーム（WhatsApp/Telegram/Slack など）はメッセージデータをサーバーに保存。
- **フットプリントをコントロール:** ローカルモデルを使用するとプロンプトがマシン上に保持されますが、チャンネルのトラフィックはチャンネルのサーバーを経由します。

関連: [エージェントワークスペース](/concepts/agent-workspace)、[メモリ](/concepts/memory)。

### OpenClaw はデータをどこに保存しますか？

すべては `$OPENCLAW_STATE_DIR`（デフォルト: `~/.openclaw`）以下に保存されます:

| パス | 目的 |
| ---- | ---- |
| `$OPENCLAW_STATE_DIR/openclaw.json` | メイン設定（JSON5） |
| `$OPENCLAW_STATE_DIR/credentials/oauth.json` | レガシー OAuth インポート（最初の使用時に認証プロファイルにコピー） |
| `$OPENCLAW_STATE_DIR/agents/<agentId>/agent/auth-profiles.json` | 認証プロファイル（OAuth、API キー、オプションの `keyRef`/`tokenRef`） |
| `$OPENCLAW_STATE_DIR/secrets.json` | `file` SecretRef プロバイダー用のオプションのファイルバックシークレットペイロード |
| `$OPENCLAW_STATE_DIR/agents/<agentId>/agent/auth.json` | レガシー互換性ファイル（静的な `api_key` エントリーはスクラブ済み） |
| `$OPENCLAW_STATE_DIR/credentials/` | プロバイダー状態（例: `whatsapp/<accountId>/creds.json`） |
| `$OPENCLAW_STATE_DIR/agents/` | エージェントごとの状態（agentDir + セッション） |
| `$OPENCLAW_STATE_DIR/agents/<agentId>/sessions/` | 会話履歴と状態（エージェントごと） |
| `$OPENCLAW_STATE_DIR/agents/<agentId>/sessions/sessions.json` | セッションメタデータ（エージェントごと） |

レガシーシングルエージェントパス: `~/.openclaw/agent/*`（`openclaw doctor` で移行）。

**ワークスペース**（AGENTS.md、メモリファイル、スキルなど）は別で、`agents.defaults.workspace`（デフォルト: `~/.openclaw/workspace`）で設定します。

### AGENTS.md / SOUL.md / USER.md / MEMORY.md はどこに置くべきですか？

これらのファイルは `~/.openclaw` ではなく**エージェントワークスペース**に置きます。

- **ワークスペース（エージェントごと）**: `AGENTS.md`、`SOUL.md`、`IDENTITY.md`、`USER.md`、
  `MEMORY.md`（または `memory.md`）、`memory/YYYY-MM-DD.md`、オプションの `HEARTBEAT.md`。
- **状態ディレクトリ（`~/.openclaw`）**: 設定、クレデンシャル、認証プロファイル、セッション、ログ、
  共有スキル（`~/.openclaw/skills`）。

デフォルトのワークスペースは `~/.openclaw/workspace` で、以下で設定可能です:

```json5
{
  agents: { defaults: { workspace: "~/.openclaw/workspace" } },
}
```

再起動後にボットが「忘れる」場合は、Gateway がすべての起動で同じワークスペースを使用していることを確認してください（リモートモードでは **Gateway ホストの**ワークスペースが使用され、ローカルラップトップではありません）。

ヒント: 持続的な動作や好みが必要な場合は、チャット履歴に頼るのではなく、ボットに**AGENTS.md または MEMORY.md に書き込むよう**依頼してください。

[エージェントワークスペース](/concepts/agent-workspace) と [メモリ](/concepts/memory) を参照してください。

### 推奨されるバックアップ戦略は？

**エージェントワークスペース**を**プライベート** git リポジトリに置き、プライベートな場所（例: GitHub プライベート）にバックアップしてください。これによりメモリ + AGENTS/SOUL/USER ファイルがキャプチャされ、後でアシスタントの「心」を復元できます。

`~/.openclaw` 以下のもの（クレデンシャル、セッション、トークン、または暗号化されたシークレットペイロード）は**コミットしないでください**。
完全な復元が必要な場合は、ワークスペースと状態ディレクトリの両方を別々にバックアップしてください（上記の移行に関する質問を参照）。

ドキュメント: [エージェントワークスペース](/concepts/agent-workspace)。

### OpenClaw を完全にアンインストールするには？

専用ガイドを参照してください: [アンインストール](/install/uninstall)。

### エージェントはワークスペースの外で作業できますか？

はい。ワークスペースは**デフォルトの cwd** とメモリのアンカーですが、ハードなサンドボックスではありません。
相対パスはワークスペース内で解決されますが、サンドボックスが有効でない限り、絶対パスは他のホストの場所にアクセスできます。分離が必要な場合は
[`agents.defaults.sandbox`](/gateway/sandboxing) またはエージェントごとのサンドボックス設定を使用してください。リポジトリをデフォルトの作業ディレクトリにしたい場合は、そのエージェントの `workspace` をリポジトリルートに向けてください。OpenClaw リポジトリは単なるソースコードです。意図的にエージェントをその中で作業させたい場合を除き、ワークスペースは別に保ってください。

例（リポジトリをデフォルト cwd として）:

```json5
{
  agents: {
    defaults: {
      workspace: "~/Projects/my-repo",
    },
  },
}
```

### リモートモードにいます。セッションストアはどこにありますか？

セッション状態は **Gateway ホスト**が所有しています。リモートモードの場合、重要なセッションストアはローカルラップトップではなくリモートマシンにあります。[セッション管理](/concepts/session) を参照してください。

## 設定の基本

### 設定のフォーマットは何ですか？どこにありますか？

OpenClaw は `$OPENCLAW_CONFIG_PATH`（デフォルト: `~/.openclaw/openclaw.json`）からオプションの **JSON5** 設定を読み込みます:

```
$OPENCLAW_CONFIG_PATH
```

ファイルが欠落している場合は、安全なデフォルトを使用します（デフォルトのワークスペースは `~/.openclaw/workspace`）。

### `gateway.bind: "lan"`（または `"tailnet"`）を設定したら何もリッスンしない / UI が unauthorized と表示される

非ループバックバインドには**認証が必要**です。`gateway.auth.mode` + `gateway.auth.token`（または `OPENCLAW_GATEWAY_TOKEN`）を設定してください。

```json5
{
  gateway: {
    bind: "lan",
    auth: {
      mode: "token",
      token: "replace-me",
    },
  },
}
```

注意:

- `gateway.remote.token` / `.password` は単独ではローカル Gateway 認証を有効にしません。
- ローカル呼び出しパスは `gateway.auth.*` が未設定の場合に `gateway.remote.*` をフォールバックとして使用できます。
- Control UI は `connect.params.auth.token`（アプリ/UI 設定に保存）で認証します。URL にトークンを入れないでください。

### localhost でトークンが必要なのはなぜですか？

OpenClaw はループバックを含むデフォルトでトークン認証を強制します。トークンが設定されていない場合、Gateway の起動時に自動生成して `gateway.auth.token` に保存します。そのため**ローカル WS クライアントは認証する必要があります**。これにより他のローカルプロセスが Gateway を呼び出すことができなくなります。

ループバックを開いたままにしたい**本当に必要な**場合は、設定で `gateway.auth.mode: "none"` を明示的に設定してください。Doctor はいつでもトークンを生成できます: `openclaw doctor --generate-gateway-token`。

### 設定変更後に再起動する必要がありますか？

Gateway は設定を監視してホットリロードをサポートしています:

- `gateway.reload.mode: "hybrid"`（デフォルト）: 安全な変更をホット適用し、重要な変更には再起動
- `hot`、`restart`、`off` もサポートされています

### Web 検索（と Web フェッチ）を有効にするには？

`web_fetch` は API キーなしで動作します。`web_search` には Brave Search API キーが必要です。**推奨:** `openclaw configure --section web` を実行して `tools.web.search.apiKey` に保存してください。環境変数の代替: Gateway プロセスに `BRAVE_API_KEY` を設定してください。

```json5
{
  tools: {
    web: {
      search: {
        enabled: true,
        apiKey: "BRAVE_API_KEY_HERE",
        maxResults: 5,
      },
      fetch: {
        enabled: true,
      },
    },
  },
}
```

注意:

- 許可リストを使用する場合は `web_search`/`web_fetch` または `group:web` を追加してください。
- `web_fetch` はデフォルトで有効です（明示的に無効化しない限り）。
- デーモンは `~/.openclaw/.env`（またはサービス環境）から環境変数を読み込みます。

ドキュメント: [Web ツール](/tools/web)。

### config.apply で設定が消えました。回復して再発を防ぐには？

`config.apply` は**設定全体**を置き換えます。部分的なオブジェクトを送ると、他のすべてが削除されます。

回復:

- バックアップ（git またはコピーした `~/.openclaw/openclaw.json`）から復元します。
- バックアップがない場合は `openclaw doctor` を再実行してチャンネル/モデルを再設定します。
- 予期しなかった場合はバグを報告し、最後に確認した設定またはバックアップを含めてください。
- ローカルのコーディングエージェントがログや履歴から動作する設定を再構築できる場合が多いです。

回避方法:

- 小さな変更には `openclaw config set` を使用します。
- インタラクティブな編集には `openclaw configure` を使用します。

ドキュメント: [設定](/cli/config)、[設定（対話式）](/cli/configure)、[Doctor](/gateway/doctor)。

### デバイス間で特定ワーカーを持つ中央 Gateway を実行するには？

一般的なパターンは **1 つの Gateway**（例: Raspberry Pi）+ **ノード**と**エージェント**です:

- **Gateway（中央）:** チャンネル（Signal/WhatsApp）、ルーティング、セッションを所有。
- **ノード（デバイス）:** Mac/iOS/Android がペリフェラルとして接続し、ローカルツール（`system.run`、`canvas`、`camera`）を公開。
- **エージェント（ワーカー）:** 特定の役割（例: 「Hetzner 運用」、「個人データ」）用の別々のブレイン/ワークスペース。
- **サブエージェント:** 並列処理が必要な場合にメインエージェントからバックグラウンド作業を生成。
- **TUI:** Gateway に接続してエージェント/セッションを切り替え。

ドキュメント: [ノード](/nodes)、[リモートアクセス](/gateway/remote)、[マルチエージェントルーティング](/concepts/multi-agent)、[サブエージェント](/tools/subagents)、[TUI](/web/tui)。

### OpenClaw のブラウザはヘッドレスで実行できますか？

はい。設定オプションです:

```json5
{
  browser: { headless: true },
  agents: {
    defaults: {
      sandbox: { browser: { headless: true } },
    },
  },
}
```

デフォルトは `false`（ヘッドフル）。ヘッドレスは一部のサイトでボット対策チェックをより多くトリガーする可能性があります。[ブラウザ](/tools/browser) を参照してください。

ヘッドレスは**同じ Chromium エンジン**を使用し、ほとんどの自動化（フォーム、クリック、スクレイピング、ログイン）で動作します。主な違いは:

- 可視ブラウザウィンドウなし（ビジュアルが必要な場合はスクリーンショットを使用）。
- 一部のサイトはヘッドレスモードの自動化に対してより厳しい（CAPTCHA、ボット対策）。
  例えば、X/Twitter はヘッドレスセッションをよくブロックします。

### ブラウザコントロールに Brave を使用するには？

`browser.executablePath` を Brave のバイナリ（または任意の Chromium ベースのブラウザ）に設定し、Gateway を再起動してください。
[ブラウザ](/tools/browser#use-brave-or-another-chromium-based-browser) の完全な設定例を参照してください。

## リモート Gateway とノード

### Telegram、Gateway、ノード間でコマンドはどのように伝播しますか？

Telegram メッセージは **Gateway** によって処理されます。Gateway はエージェントを実行し、ノードツールが必要な場合にのみ **Gateway WebSocket** 経由でノードを呼び出します:

Telegram → Gateway → エージェント → `node.*` → ノード → Gateway → Telegram

ノードはインバウンドプロバイダーのトラフィックを見ません。ノード RPC 呼び出しのみを受信します。

### Gateway がリモートでホストされている場合、エージェントはどのようにコンピューターにアクセスできますか？

簡単に言うと: **コンピューターをノードとしてペアリング**してください。Gateway は別の場所で実行されますが、Gateway WebSocket 経由でローカルマシンの `node.*` ツール（スクリーン、カメラ、システム）を呼び出せます。

典型的なセットアップ:

1. 常時稼働のホスト（VPS/ホームサーバー）で Gateway を実行します。
2. Gateway ホストとコンピューターを同じ tailnet に置きます。
3. Gateway の WS が到達可能であることを確認します（tailnet バインドまたは SSH トンネル）。
4. macOS アプリをローカルで**リモート over SSH** モード（または直接 tailnet）で開いてノードとして登録します。
5. Gateway でノードを承認します:

   ```bash
   openclaw nodes pending
   openclaw nodes approve <requestId>
   ```

別の TCP ブリッジは不要です。ノードは Gateway WebSocket 経由で接続します。

セキュリティの注意: macOS ノードをペアリングすると、そのマシンで `system.run` が許可されます。信頼するデバイスのみをペアリングし、[セキュリティ](/gateway/security) を確認してください。

ドキュメント: [ノード](/nodes)、[Gateway プロトコル](/gateway/protocol)、[macOS リモートモード](/platforms/mac/remote)、[セキュリティ](/gateway/security)。

### Tailscale は接続されていますが返信がありません。どうすれば？

基本を確認してください:

- Gateway が実行中: `openclaw gateway status`
- Gateway のヘルス: `openclaw status`
- チャンネルのヘルス: `openclaw channels status`

次に認証とルーティングを確認してください:

- Tailscale Serve を使用している場合は、`gateway.auth.allowTailscale` が正しく設定されていることを確認してください。
- SSH トンネル経由で接続している場合は、ローカルトンネルが起動していて正しいポートを指していることを確認してください。
- 許可リスト（DM またはグループ）にアカウントが含まれていることを確認してください。

ドキュメント: [Tailscale](/gateway/tailscale)、[リモートアクセス](/gateway/remote)、[チャンネル](/channels)。

### 2 つの OpenClaw インスタンスは互いに通信できますか（ローカル + VPS）？

はい。ビルトインの「ボット間ブリッジ」はありませんが、いくつかの信頼性の高い方法でつなぐことができます:

**最もシンプル:** 両方のボットがアクセスできる通常のチャットチャンネルを使用します（Telegram/Slack/WhatsApp）。
ボット A がボット B にメッセージを送り、ボット B が通常通り返信します。

**CLI ブリッジ（汎用）:** もう一方の Gateway を
`openclaw agent --message ... --deliver` で呼び出すスクリプトを実行し、もう一方のボットがリッスンしているチャットをターゲットにします。もう一方のボットがリモート VPS にある場合は、SSH/Tailscale 経由でその Gateway を CLI からターゲットにします（[リモートアクセス](/gateway/remote) を参照）。

パターン例（ターゲット Gateway に到達できるマシンから実行）:

```bash
openclaw agent --message "Hello from local bot" --deliver --channel telegram --reply-to <chat-id>
```

ヒント: 2 つのボットが無限ループしないようにガードレールを追加してください（メンションのみ、チャンネル許可リスト、または「ボットメッセージに返信しない」ルール）。

ドキュメント: [リモートアクセス](/gateway/remote)、[エージェント CLI](/cli/agent)、[エージェント送信](/tools/agent-send)。

### 複数のエージェントに個別の VPS が必要ですか？

いいえ。1 つの Gateway で複数のエージェントをホストでき、それぞれに独自のワークスペース、モデルのデフォルト、ルーティングがあります。これが通常のセットアップであり、エージェントごとに 1 つの VPS を実行するよりもはるかに安価でシンプルです。

ハードな分離（セキュリティ境界）や共有したくない非常に異なる設定が必要な場合にのみ、別々の VPS を使用してください。そうでない場合は 1 つの Gateway を維持し、複数のエージェントやサブエージェントを使用してください。

### VPS からの SSH の代わりに個人のラップトップでノードを使用する利点はありますか？

はい。ノードはリモート Gateway からラップトップに到達するための第一級の方法であり、シェルアクセス以上のものを提供します。Gateway は macOS/Linux（Windows は WSL2 経由）で実行され軽量です（小さな VPS または Raspberry Pi クラスのボックスで十分; 4GB RAM で余裕）。一般的なセットアップは常時稼働のホストとラップトップをノードとして使用することです。

- **インバウンド SSH 不要。** ノードは Gateway WebSocket に接続し、デバイスペアリングを使用します。
- **より安全な実行コントロール。** `system.run` はそのラップトップのノード許可リスト/承認でゲートされています。
- **より多くのデバイスツール。** ノードは `system.run` に加えて `canvas`、`camera`、`screen` を公開します。
- **ローカルブラウザ自動化。** Gateway を VPS に維持しつつ、Chrome をローカルで実行し、Chrome 拡張機能 + ラップトップのノードホストでコントロールをリレーします。

SSH はアドホックなシェルアクセスには問題ありませんが、ノードは継続的なエージェントワークフローとデバイス自動化にはよりシンプルです。

ドキュメント: [ノード](/nodes)、[ノード CLI](/cli/nodes)、[Chrome 拡張機能](/tools/chrome-extension)。

### 2 台目のラップトップにインストールすべきか、ノードを追加するだけにすべきか？

2 台目のラップトップに**ローカルツール**（スクリーン/カメラ/exec）だけが必要な場合は、**ノード**として追加してください。これにより 1 つの Gateway が維持され、設定の重複を避けられます。ローカルノードツールは現在 macOS のみですが、他の OS への拡張を計画しています。

**ハードな分離**または 2 つの完全に別々のボットが必要な場合にのみ 2 台目の Gateway をインストールしてください。

ドキュメント: [ノード](/nodes)、[ノード CLI](/cli/nodes)、[複数の Gateway](/gateway/multiple-gateways)。

### ノードは Gateway サービスを実行しますか？

いいえ。意図的に分離されたプロファイルを実行する場合を除き（[複数の Gateway](/gateway/multiple-gateways) を参照）、ホストごとに **1 つの Gateway** のみを実行してください。ノードは Gateway に接続するペリフェラルです（iOS/Android ノード、またはメニューバーアプリの macOS「ノードモード」）。ヘッドレスノードホストと CLI コントロールについては [ノードホスト CLI](/cli/node) を参照してください。

`gateway`、`discovery`、`canvasHost` の変更には完全な再起動が必要です。

### 設定を適用する API / RPC の方法はありますか？

はい。`config.apply` は設定全体を検証して書き込み、操作の一部として Gateway を再起動します。

### config.apply で設定が消えました。回復して再発を防ぐには？

`config.apply` は**設定全体**を置き換えます。部分的なオブジェクトを送ると、他のすべてが削除されます。

回復:

- バックアップ（git またはコピーした `~/.openclaw/openclaw.json`）から復元します。
- バックアップがない場合は `openclaw doctor` を再実行してチャンネル/モデルを再設定します。
- 予期しなかった場合はバグを報告し、最後に確認した設定またはバックアップを含めてください。
- ローカルのコーディングエージェントがログや履歴から動作する設定を再構築できる場合が多いです。

回避方法:

- 小さな変更には `openclaw config set` を使用します。
- インタラクティブな編集には `openclaw configure` を使用します。

ドキュメント: [設定](/cli/config)、[設定（対話式）](/cli/configure)、[Doctor](/gateway/doctor)。

### 最初のインストール向けの最小限の「まともな」設定は？

```json5
{
  agents: { defaults: { workspace: "~/.openclaw/workspace" } },
  channels: { whatsapp: { allowFrom: ["+15555550123"] } },
}
```

これによりワークスペースが設定され、ボットをトリガーできる人が制限されます。

### VPS に Tailscale をセットアップして Mac から接続するには？

最小限の手順:

1. **VPS でインストール + ログイン**

   ```bash
   curl -fsSL https://tailscale.com/install.sh | sh
   sudo tailscale up
   ```

2. **Mac でインストール + ログイン**
   - Tailscale アプリを使用して同じ tailnet にサインインします。
3. **MagicDNS を有効化（推奨）**
   - Tailscale 管理コンソールで MagicDNS を有効化して VPS に安定した名前を付けます。
4. **tailnet のホスト名を使用**
   - SSH: `ssh user@your-vps.tailnet-xxxx.ts.net`
   - Gateway WS: `ws://your-vps.tailnet-xxxx.ts.net:18789`

SSH なしで Control UI が必要な場合は、VPS で Tailscale Serve を使用してください:

```bash
openclaw gateway --tailscale serve
```

これにより Gateway はループバックにバインドされ、HTTPS が Tailscale 経由で公開されます。[Tailscale](/gateway/tailscale) を参照してください。

### Mac ノードをリモート Gateway（Tailscale Serve）に接続するには？

Serve は **Gateway の Control UI + WS** を公開します。ノードは同じ Gateway WS エンドポイント経由で接続します。

推奨セットアップ:

1. **VPS と Mac が同じ tailnet に接続していることを確認します**。
2. **macOS アプリをリモートモードで使用します**（SSH ターゲットは tailnet のホスト名にできます）。
   アプリは Gateway ポートをトンネルし、ノードとして接続します。
3. **Gateway でノードを承認します**:

   ```bash
   openclaw nodes pending
   openclaw nodes approve <requestId>
   ```

ドキュメント: [Gateway プロトコル](/gateway/protocol)、[ディスカバリー](/gateway/discovery)、[macOS リモートモード](/platforms/mac/remote)。


## 環境変数と .env の読み込み

### OpenClaw はどのように環境変数を読み込みますか？

OpenClaw は親プロセス（シェル、launchd/systemd、CI など）から環境変数を読み込み、さらに以下も読み込みます:

- カレントディレクトリの `.env`
- `~/.openclaw/.env`（別名 `$OPENCLAW_STATE_DIR/.env`）からのグローバルフォールバック `.env`

どちらの `.env` ファイルも既存の環境変数を上書きしません。

設定内でインライン環境変数を定義することもできます（プロセス環境に欠落している場合のみ適用）:

```json5
{
  env: {
    OPENROUTER_API_KEY: "sk-or-...",
    vars: { GROQ_API_KEY: "gsk-..." },
  },
}
```

完全な優先順位とソースについては [/environment](/help/environment) を参照してください。

### 「サービスで Gateway を起動したら環境変数が消えた。」どうすれば？

よくある 2 つの修正:

1. 不足しているキーを `~/.openclaw/.env` に置いてください。サービスがシェル環境を継承しない場合でも取得されます。
2. シェルインポートを有効にします（オプトインの便利機能）:

```json5
{
  env: {
    shellEnv: {
      enabled: true,
      timeoutMs: 15000,
    },
  },
}
```

これによりログインシェルが実行され、欠落している期待されるキーのみがインポートされます（上書きしません）。同等の環境変数:
`OPENCLAW_LOAD_SHELL_ENV=1`、`OPENCLAW_SHELL_ENV_TIMEOUT_MS=15000`。

### `COPILOT_GITHUB_TOKEN` を設定しましたが、models status に「Shell env: off」と表示されます。なぜ？

`openclaw models status` は**シェル環境インポート**が有効かどうかを報告します。「Shell env: off」は
環境変数が欠落しているという意味では**ありません**。OpenClaw がログインシェルを自動的に読み込まないというだけです。

Gateway がサービス（launchd/systemd）として実行される場合、シェル環境を継承しません。
以下のいずれかで修正してください:

1. トークンを `~/.openclaw/.env` に置きます:

   ```
   COPILOT_GITHUB_TOKEN=...
   ```

2. またはシェルインポートを有効にします（`env.shellEnv.enabled: true`）。
3. または設定の `env` ブロックに追加します（欠落している場合のみ適用）。

次に Gateway を再起動して再確認します:

```bash
openclaw models status
```

Copilot トークンは `COPILOT_GITHUB_TOKEN`（`GH_TOKEN` / `GITHUB_TOKEN` も）から読み込まれます。
[/concepts/model-providers](/concepts/model-providers) と [/environment](/help/environment) を参照してください。

## セッションと複数のチャット

### 新しい会話を開始するには？

スタンドアロンメッセージとして `/new` または `/reset` を送信してください。[セッション管理](/concepts/session) を参照してください。

### `/new` を送らなければセッションは自動的にリセットされますか？

はい。セッションは `session.idleMinutes`（デフォルト **60**）後に期限切れになります。**次の**
メッセージがそのチャットキーの新しいセッション ID を開始します。これはトランスクリプトを削除しません。新しいセッションを開始するだけです。

```json5
{
  session: {
    idleMinutes: 240,
  },
}
```

### OpenClaw インスタンスのチーム（1 つの CEO と多くのエージェント）を作れますか？

はい。**マルチエージェントルーティング**と**サブエージェント**経由で。1 つのコーディネーターエージェントと独自のワークスペースとモデルを持つ複数のワーカーエージェントを作成できます。

とはいえ、これは**楽しい実験**として見るのが最善です。トークンが多くかかり、1 つのボットと別々のセッションを使用するよりも効率が低いことが多いです。私たちが想定する典型的なモデルは、あなたが話しかける 1 つのボットで、並行作業のための別々のセッションがあることです。そのボットは必要に応じてサブエージェントを生成することもできます。

ドキュメント: [マルチエージェントルーティング](/concepts/multi-agent)、[サブエージェント](/tools/subagents)、[エージェント CLI](/cli/agents)。

### タスクの途中でコンテキストが切り捨てられたのはなぜですか？防ぐには？

セッションコンテキストはモデルのウィンドウによって制限されます。長いチャット、大きなツール出力、多くのファイルはコンパクションまたは切り捨てをトリガーする可能性があります。

役立つこと:

- ボットに現在の状態を要約してファイルに書くよう依頼します。
- 長いタスクの前に `/compact` を使用し、トピックを切り替えるときに `/new` を使用します。
- 重要なコンテキストをワークスペースに保持し、ボットに読み直させます。
- メインチャットを小さく保つために、長いまたは並行した作業にはサブエージェントを使用します。
- これがよく発生する場合はより大きなコンテキストウィンドウを持つモデルを選択します。

### インストールを維持したまま OpenClaw を完全にリセットするには？

リセットコマンドを使用してください:

```bash
openclaw reset
```

非インタラクティブなフルリセット:

```bash
openclaw reset --scope full --yes --non-interactive
```

次にオンボーディングを再実行します:

```bash
openclaw onboard --install-daemon
```

注意:

- オンボーディングウィザードは既存の設定を確認した場合に**リセット**オプションも提供します。[ウィザード](/start/wizard) を参照してください。
- プロファイル（`--profile` / `OPENCLAW_PROFILE`）を使用した場合は、各状態ディレクトリをリセットしてください（デフォルトは `~/.openclaw-<profile>`）。
- Dev リセット: `openclaw gateway --dev --reset`（Dev のみ; Dev 設定 + クレデンシャル + セッション + ワークスペースを削除）。

### 「context too large」エラーが出ています。リセットまたはコンパクトするには？

以下のいずれかを使用してください:

- **コンパクト**（会話を保持しつつ古いターンを要約）:

  ```
  /compact
  ```

  または `/compact <instructions>` でサマリーをガイドします。

- **リセット**（同じチャットキーの新しいセッション ID）:

  ```
  /new
  /reset
  ```

繰り返し発生する場合:

- **セッションプルーニング**（`agents.defaults.contextPruning`）を有効化または調整して古いツール出力をトリムします。
- より大きなコンテキストウィンドウを持つモデルを使用します。

ドキュメント: [コンパクション](/concepts/compaction)、[セッションプルーニング](/concepts/session-pruning)、[セッション管理](/concepts/session)。

### 「LLM request rejected: messages.content.tool_use.input field required」が表示されるのはなぜですか？

これはプロバイダーのバリデーションエラーです。モデルが必要な `input` なしで `tool_use` ブロックを発行しました。通常、セッション履歴が古いまたは破損していることを意味します（多くの場合、長いスレッドやツール/スキーマの変更後）。

修正: スタンドアロンメッセージとして `/new` で新しいセッションを開始してください。

### 30 分ごとにハートビートメッセージが届くのはなぜですか？

ハートビートはデフォルトで **30 分**ごとに実行されます。調整または無効化してください:

```json5
{
  agents: {
    defaults: {
      heartbeat: {
        every: "2h", // または "0m" で無効化
      },
    },
  },
}
```

`HEARTBEAT.md` が存在するが実質的に空（空行と `# Heading` のような Markdown ヘッダーのみ）の場合、OpenClaw は API 呼び出しを節約するためにハートビートの実行をスキップします。
ファイルが欠落している場合、ハートビートは引き続き実行され、モデルが何をするかを決定します。

エージェントごとのオーバーライドは `agents.list[].heartbeat` を使用します。ドキュメント: [ハートビート](/gateway/heartbeat)。

### WhatsApp グループに「ボットアカウント」を追加する必要がありますか？

いいえ。OpenClaw は**あなた自身のアカウント**で実行されるため、グループにいれば OpenClaw はそれを見ることができます。
デフォルトでは `groupPolicy: "allowlist"` で送信者を許可するまでグループの返信はブロックされます。

**あなただけ**がグループの返信をトリガーできるようにしたい場合:

```json5
{
  channels: {
    whatsapp: {
      groupPolicy: "allowlist",
      groupAllowFrom: ["+15551234567"],
    },
  },
}
```

### WhatsApp グループの JID を取得するには？

オプション 1（最速）: ログをテールしてグループにテストメッセージを送信してください:

```bash
openclaw logs --follow --json
```

`@g.us` で終わる `chatId`（または `from`）を探します（例:
`1234567890-1234567890@g.us`）。

オプション 2（すでに設定/許可リスト済みの場合）: 設定からグループをリストします:

```bash
openclaw directory groups list --channel whatsapp
```

ドキュメント: [WhatsApp](/channels/whatsapp)、[ディレクトリ](/cli/directory)、[ログ](/cli/logs)。

### OpenClaw がグループで返信しないのはなぜですか？

よくある 2 つの原因:

- メンションゲーティングが有効（デフォルト）。ボットを @メンションするか `mentionPatterns` に一致する必要があります。
- `channels.whatsapp.groups` を `"*"` なしで設定し、グループが許可リストにない。

[グループ](/channels/groups) と [グループメッセージ](/channels/group-messages) を参照してください。

### グループ/スレッドは DM とコンテキストを共有しますか？

ダイレクトチャットはデフォルトでメインセッションに集約されます。グループ/チャンネルは独自のセッションキーを持ち、Telegram トピック / Discord スレッドは別のセッションです。[グループ](/channels/groups) と [グループメッセージ](/channels/group-messages) を参照してください。

### ワークスペースとエージェントはいくつ作成できますか？

ハードな制限はありません。数十（数百も）問題ありませんが、注意が必要なことがあります:

- **ディスクの増大:** セッション + トランスクリプトは `~/.openclaw/agents/<agentId>/sessions/` 以下に保存されます。
- **トークンコスト:** エージェントが多いほど、同時モデル使用量が増えます。
- **運用オーバーヘッド:** エージェントごとの認証プロファイル、ワークスペース、チャンネルルーティング。

ヒント:

- エージェントごとに 1 つの**アクティブな**ワークスペース（`agents.defaults.workspace`）を保持します。
- ディスクが増大した場合は古いセッションをプルーニングします（JSONL またはストアエントリーを削除）。
- `openclaw doctor` を使用して迷子のワークスペースとプロファイルの不一致を見つけます。

### 複数のボットやチャットを同時に実行できますか（Slack）？セットアップ方法は？

はい。**マルチエージェントルーティング**を使用して複数の分離されたエージェントを実行し、チャンネル/アカウント/ピアでインバウンドメッセージをルーティングします。Slack はチャンネルとしてサポートされており、特定のエージェントにバインドできます。

ブラウザアクセスは強力ですが「人間ができることは何でも」ではありません。ボット対策、CAPTCHA、MFA は依然として自動化をブロックできます。最も信頼性の高いブラウザコントロールには、ブラウザを実行するマシンで Chrome 拡張機能リレーを使用します（Gateway はどこにでも置けます）。

ベストプラクティスのセットアップ:

- 常時稼働の Gateway ホスト（VPS/Mac mini）。
- 役割ごとに 1 つのエージェント（バインディング）。
- それらのエージェントにバインドされた Slack チャンネル。
- 必要に応じて拡張機能リレー（またはノード）経由のローカルブラウザ。

ドキュメント: [マルチエージェントルーティング](/concepts/multi-agent)、[Slack](/channels/slack)、
[ブラウザ](/tools/browser)、[Chrome 拡張機能](/tools/chrome-extension)、[ノード](/nodes)。

## モデル: デフォルト、選択、エイリアス、切り替え

### 「デフォルトモデル」とは？

OpenClaw のデフォルトモデルは以下で設定するものです:

```
agents.defaults.model.primary
```

モデルは `provider/model` として参照されます（例: `anthropic/claude-opus-4-6`）。プロバイダーを省略すると、OpenClaw は一時的なフォールバックとして現在 `anthropic` を想定しますが、明示的に `provider/model` を設定すべきです。

### 推奨モデルは？

**推奨デフォルト:** `anthropic/claude-opus-4-6`。
**良い代替:** `anthropic/claude-sonnet-4-5`。
**信頼性が高い（キャラクターは少ない）:** `openai/gpt-5.2`。Opus に近い性能ですが、個性は少ない。
**バジェット:** `zai/glm-4.7`。

MiniMax M2.1 には独自のドキュメントがあります: [MiniMax](/providers/minimax) と
[ローカルモデル](/gateway/local-models)。

経験則: 重要な作業には**余裕のある最高のモデル**を使用し、日常的なチャットやサマリーには安価なモデルを使用してください。エージェントごとにモデルをルーティングし、サブエージェントを使用して長いタスクを並列化できます（各サブエージェントはトークンを消費）。[モデル](/concepts/models) と
[サブエージェント](/tools/subagents) を参照してください。

強い警告: 弱い/過度に量子化されたモデルはプロンプトインジェクションや安全でない動作に対してより脆弱です。[セキュリティ](/gateway/security) を参照してください。

詳細コンテキスト: [モデル](/concepts/models)。

### 設定を消去せずにモデルを切り替えるには？

**モデルコマンド**を使用するか、**モデル**フィールドのみを編集してください。設定全体の置き換えは避けてください。

安全なオプション:

- チャットで `/model`（クイック、セッションごと）
- `openclaw models set ...`（モデル設定のみを更新）
- `openclaw configure --section model`（インタラクティブ）
- `~/.openclaw/openclaw.json` の `agents.defaults.model` を編集

設定全体を置き換えるつもりでない限り、部分的なオブジェクトで `config.apply` を使用することは避けてください。
設定を上書きした場合は、バックアップから復元するか `openclaw doctor` を再実行して修復してください。

ドキュメント: [モデル](/concepts/models)、[設定（対話式）](/cli/configure)、[設定](/cli/config)、[Doctor](/gateway/doctor)。

### OpenClaw、Flawd、Krill はどのモデルを使用していますか？

- **OpenClaw + Flawd:** Anthropic Opus（`anthropic/claude-opus-4-6`）。[Anthropic](/providers/anthropic) を参照してください。
- **Krill:** MiniMax M2.1（`minimax/MiniMax-M2.1`）。[MiniMax](/providers/minimax) を参照してください。

### 再起動なしでその場でモデルを切り替えるには？

スタンドアロンメッセージとして `/model` コマンドを使用してください:

```
/model sonnet
/model haiku
/model opus
/model gpt
/model gpt-mini
/model gemini
/model gemini-flash
```

利用可能なモデルを `/model`、`/model list`、または `/model status` でリストできます。

`/model`（と `/model list`）はコンパクトで番号付きのピッカーを表示します。番号で選択:

```
/model 3
```

プロバイダーの特定の認証プロファイルを強制することもできます（セッションごと）:

```
/model opus@anthropic:default
/model opus@anthropic:work
```

ヒント: `/model status` はどのエージェントがアクティブか、どの `auth-profiles.json` ファイルが使用されているか、次に試される認証プロファイルを表示します。
利用可能な場合は設定されたプロバイダーエンドポイント（`baseUrl`）と API モード（`api`）も表示します。

**プロファイルで設定したプロファイルをアンピンするには？**

`@profile` サフィックス**なし**で `/model` を再実行してください:

```
/model anthropic/claude-opus-4-6
```

デフォルトに戻したい場合は `/model` から選択してください（または `/model <デフォルトプロバイダー/モデル>` を送信）。
`/model status` でどの認証プロファイルがアクティブかを確認してください。

### 日常タスクに GPT 5.2、コーディングに Codex 5.3 を使用できますか？

はい。一方をデフォルトに設定して必要に応じて切り替えます:

- **クイック切り替え（セッションごと）:** 日常タスクには `/model gpt-5.2`、コーディングには `/model gpt-5.3-codex`。
- **デフォルト + 切り替え:** `agents.defaults.model.primary` を `openai/gpt-5.2` に設定し、コーディング時に `openai-codex/gpt-5.3-codex` に切り替えます（またはその逆）。
- **サブエージェント:** コーディングタスクを異なるデフォルトモデルを持つサブエージェントにルーティングします。

[モデル](/concepts/models) と [スラッシュコマンド](/tools/slash-commands) を参照してください。

### 「Model … is not allowed」と表示されて返信がないのはなぜですか？

`agents.defaults.models` が設定されている場合、`/model` とセッションオーバーライドの**許可リスト**になります。そのリストにないモデルを選択すると以下が返されます:

```
Model "provider/model" is not allowed. Use /model to list available models.
```

このエラーは通常の返信の**代わりに**返されます。修正: `agents.defaults.models` にモデルを追加するか、許可リストを削除するか、`/model list` からモデルを選択してください。

### 「Unknown model: minimax/MiniMax-M2.1」が表示されるのはなぜですか？

これは**プロバイダーが設定されていない**ことを意味します（MiniMax プロバイダー設定または認証プロファイルが見つかりませんでした）。そのため、モデルを解決できません。この検出の修正は **2026.1.12** にあります（執筆時点では未リリース）。

修正チェックリスト:

1. **2026.1.12** にアップグレードします（またはソース `main` から実行）し、Gateway を再起動します。
2. MiniMax が設定されていることを確認します（ウィザードまたは JSON）、あるいはプロバイダーを注入できるように env/認証プロファイルに MiniMax API キーが存在することを確認します。
3. 正確なモデル ID を使用します（大文字小文字の区別あり）: `minimax/MiniMax-M2.1` または
   `minimax/MiniMax-M2.1-lightning`。
4. 以下を実行します:

   ```bash
   openclaw models list
   ```

   リストから選択します（またはチャットで `/model list`）。

[MiniMax](/providers/minimax) と [モデル](/concepts/models) を参照してください。

### デフォルトに MiniMax、複雑なタスクに OpenAI を使用できますか？

はい。**MiniMax をデフォルト**に使用し、必要に応じて**セッションごとに**モデルを切り替えます。
フォールバックは**エラー**用であり、「難しいタスク」用ではないので、`/model` または別のエージェントを使用してください。

**オプション A: セッションごとに切り替え**

```json5
{
  env: { MINIMAX_API_KEY: "sk-...", OPENAI_API_KEY: "sk-..." },
  agents: {
    defaults: {
      model: { primary: "minimax/MiniMax-M2.1" },
      models: {
        "minimax/MiniMax-M2.1": { alias: "minimax" },
        "openai/gpt-5.2": { alias: "gpt" },
      },
    },
  },
}
```

次に:

```
/model gpt
```

**オプション B: 別々のエージェント**

- エージェント A のデフォルト: MiniMax
- エージェント B のデフォルト: OpenAI
- エージェントでルーティングするか `/agent` で切り替え

ドキュメント: [モデル](/concepts/models)、[マルチエージェントルーティング](/concepts/multi-agent)、[MiniMax](/providers/minimax)、[OpenAI](/providers/openai)。

### opus / sonnet / gpt はビルトインショートカットですか？

はい。OpenClaw にはデフォルトのショートハンドがいくつか組み込まれています（`agents.defaults.models` にモデルが存在する場合にのみ適用）:

- `opus` → `anthropic/claude-opus-4-6`
- `sonnet` → `anthropic/claude-sonnet-4-5`
- `gpt` → `openai/gpt-5.2`
- `gpt-mini` → `openai/gpt-5-mini`
- `gemini` → `google/gemini-3-pro-preview`
- `gemini-flash` → `google/gemini-3-flash-preview`

同じ名前で独自のエイリアスを設定した場合は、あなたの値が優先されます。

### モデルショートカット（エイリアス）を定義/オーバーライドするには？

エイリアスは `agents.defaults.models.<modelId>.alias` から来ます。例:

```json5
{
  agents: {
    defaults: {
      model: { primary: "anthropic/claude-opus-4-6" },
      models: {
        "anthropic/claude-opus-4-6": { alias: "opus" },
        "anthropic/claude-sonnet-4-5": { alias: "sonnet" },
        "anthropic/claude-haiku-4-5": { alias: "haiku" },
      },
    },
  },
}
```

次に `/model sonnet`（またはサポートされている場合は `/<alias>`）がそのモデル ID に解決されます。

### OpenRouter や Z.AI などの他のプロバイダーからモデルを追加するには？

OpenRouter（トークン従量課金; 多くのモデル）:

```json5
{
  agents: {
    defaults: {
      model: { primary: "openrouter/anthropic/claude-sonnet-4-5" },
      models: { "openrouter/anthropic/claude-sonnet-4-5": {} },
    },
  },
  env: { OPENROUTER_API_KEY: "sk-or-..." },
}
```

Z.AI（GLM モデル）:

```json5
{
  agents: {
    defaults: {
      model: { primary: "zai/glm-4.7" },
      models: { "zai/glm-4.7": {} },
    },
  },
  env: { ZAI_API_KEY: "..." },
}
```

プロバイダー/モデルを参照しても必要なプロバイダーキーが欠落している場合は、ランタイム認証エラーが発生します（例: `No API key found for provider "zai"`）。

**新しいエージェントを追加後に「No API key found for provider」が表示される**

通常、**新しいエージェント**の認証ストアが空であることを意味します。認証はエージェントごとで、以下に保存されます:

```
~/.openclaw/agents/<agentId>/agent/auth-profiles.json
```

修正オプション:

- `openclaw agents add <id>` を実行して、ウィザード中に認証を設定します。
- または、メインエージェントの `agentDir` から `auth-profiles.json` を新しいエージェントの `agentDir` にコピーします。

エージェント間で `agentDir` を再利用しないでください。認証/セッションの衝突が発生します。

## モデルフェイルオーバーと「All models failed」

### フェイルオーバーはどのように機能しますか？

フェイルオーバーは 2 つのステージで発生します:

1. 同じプロバイダー内での**認証プロファイルのローテーション**。
2. `agents.defaults.model.fallbacks` の次のモデルへの**モデルフォールバック**。

失敗したプロファイルにはクールダウンが適用されます（指数バックオフ）。そのため、プロバイダーがレート制限されたり一時的に失敗した場合でも、OpenClaw は応答し続けることができます。

### このエラーはどういう意味ですか？

```
No credentials found for profile "anthropic:default"
```

システムが認証プロファイル ID `anthropic:default` を使用しようとしましたが、期待される認証ストアでクレデンシャルを見つけられませんでした。

### `No credentials found for profile "anthropic:default"` の修正チェックリスト

- **認証プロファイルの場所を確認**（新しいパス vs レガシーパス）
  - 現在: `~/.openclaw/agents/<agentId>/agent/auth-profiles.json`
  - レガシー: `~/.openclaw/agent/*`（`openclaw doctor` で移行）
- **環境変数が Gateway によって読み込まれていることを確認**
  - シェルで `ANTHROPIC_API_KEY` を設定しても systemd/launchd 経由で Gateway を実行する場合は継承されない場合があります。`~/.openclaw/.env` に置くか `env.shellEnv` を有効にしてください。
- **正しいエージェントを編集していることを確認**
  - マルチエージェントのセットアップでは複数の `auth-profiles.json` ファイルが存在する場合があります。
- **モデル/認証ステータスのサニティチェック**
  - `openclaw models status` を使用して設定されたモデルとプロバイダーが認証されているかどうかを確認します。

**「No credentials found for profile anthropic」の修正チェックリスト**

実行が Anthropic の認証プロファイルにピン留めされていますが、Gateway がその認証ストアで見つけられません。

- **setup-token を使用する**
  - `claude setup-token` を実行し、`openclaw models auth setup-token --provider anthropic` で貼り付けます。
  - トークンが別のマシンで作成された場合は `openclaw models auth paste-token --provider anthropic` を使用します。
- **代わりに API キーを使用したい場合**
  - **Gateway ホスト**の `~/.openclaw/.env` に `ANTHROPIC_API_KEY` を置きます。
  - 欠落しているプロファイルを強制するピン留め順序をクリアします:

    ```bash
    openclaw models auth order clear --provider anthropic
    ```

- **Gateway ホストでコマンドを実行していることを確認**
  - リモートモードでは、認証プロファイルはラップトップではなく Gateway マシンにあります。

### なぜ Google Gemini も試みて失敗したのですか？

モデル設定に Google Gemini がフォールバックとして含まれている場合（または Gemini ショートハンドに切り替えた場合）、OpenClaw はモデルフォールバック中にそれを試みます。Google のクレデンシャルを設定していない場合は `No API key found for provider "google"` が表示されます。

修正: Google 認証を提供するか、フォールバックがそこにルーティングしないように `agents.defaults.model.fallbacks` / エイリアスから Google モデルを削除/回避してください。

**「LLM request rejected message thinking signature required google antigravity」**

原因: セッション履歴に**署名のない思考ブロック**が含まれています（多くの場合、中断/部分ストリームから）。Google Antigravity は思考ブロックに署名を必要とします。

修正: OpenClaw は現在 Google Antigravity Claude の署名なし思考ブロックを除去します。まだ表示される場合は、**新しいセッション**を開始するか、そのエージェントに `/thinking off` を設定してください。

## 認証プロファイル: 概要と管理方法

関連: [/concepts/oauth](/concepts/oauth)（OAuth フロー、トークンストレージ、マルチアカウントパターン）

### 認証プロファイルとは？

認証プロファイルはプロバイダーに紐付けられた名前付きクレデンシャルレコード（OAuth または API キー）です。プロファイルは以下に保存されます:

```
~/.openclaw/agents/<agentId>/agent/auth-profiles.json
```

### 典型的なプロファイル ID は？

OpenClaw はプロバイダープレフィックス付きの ID を使用します（例:

- `anthropic:default`（メール ID が存在しない場合によくある）
- OAuth ID の `anthropic:<email>`
- あなたが選択したカスタム ID（例: `anthropic:work`）

### 最初に試す認証プロファイルを制御できますか？

はい。設定はプロファイルのオプションのメタデータとプロバイダーごとの順序（`auth.order.<provider>`）をサポートしています。これはシークレットを保存**しません**。ID をプロバイダー/モードにマッピングしてローテーション順序を設定します。

OpenClaw は短い**クールダウン**（レート制限/タイムアウト/認証失敗）または長い**無効**状態（請求/クレジット不足）にあるプロファイルを一時的にスキップする場合があります。これを検査するには `openclaw models status --json` を実行して `auth.unusableProfiles` を確認してください。チューニング: `auth.cooldowns.billingBackoffHours*`。

CLI 経由でエージェントごとの順序オーバーライドを設定することもできます（そのエージェントの `auth-profiles.json` に保存）:

```bash
# 設定されたデフォルトエージェントにデフォルト（--agent を省略）
openclaw models auth order get --provider anthropic

# ローテーションを単一プロファイルに固定（これのみを試す）
openclaw models auth order set --provider anthropic anthropic:default

# または明示的な順序を設定（プロバイダー内のフォールバック）
openclaw models auth order set --provider anthropic anthropic:work anthropic:default

# オーバーライドをクリア（設定の auth.order / ラウンドロビンにフォールバック）
openclaw models auth order clear --provider anthropic
```

特定のエージェントをターゲットにするには:

```bash
openclaw models auth order set --provider anthropic --agent main anthropic:default
```

### OAuth vs API キー: 違いは？

OpenClaw は両方をサポートしています:

- **OAuth** は多くの場合サブスクリプションアクセスを活用します（適用可能な場合）。
- **API キー**はトークン従量課金を使用します。

ウィザードは Anthropic の setup-token と OpenAI Codex OAuth を明示的にサポートし、API キーも保存できます。

## Gateway: ポート、「already running」、リモートモード

### Gateway が使用するポートは？

`gateway.port` は WebSocket + HTTP（Control UI、フック等）用の単一の多重化ポートを制御します。

優先順位:

```
--port > OPENCLAW_GATEWAY_PORT > gateway.port > デフォルト 18789
```

### `openclaw gateway status` が `Runtime: running` と表示するが `RPC probe: failed` になるのはなぜですか？

「running」はスーパーバイザー（launchd/systemd/schtasks）の**見方**だからです。RPC プローブは CLI が実際に Gateway WebSocket に接続して `status` を呼び出すことです。

`openclaw gateway status` を使用してこれらの行を信頼してください:

- `Probe target:`（プローブが実際に使用した URL）
- `Listening:`（ポートで実際にバインドされているもの）
- `Last gateway error:`（プロセスは生きているがポートがリッスンしていない場合の一般的な根本原因）

### `openclaw gateway status` が `Config (cli)` と `Config (service)` で異なる値を表示するのはなぜですか？

サービスが別の設定ファイルを実行している間に一方の設定ファイルを編集しています（多くの場合 `--profile` / `OPENCLAW_STATE_DIR` の不一致）。

修正:

```bash
openclaw gateway install --force
```

サービスに使用させたい `--profile` / 環境と同じものから実行してください。

### 「another gateway instance is already listening」とはどういう意味ですか？

OpenClaw は起動時にすぐに WebSocket リスナーをバインドしてランタイムロックを強制します（デフォルト `ws://127.0.0.1:18789`）。バインドが `EADDRINUSE` で失敗すると、別のインスタンスがすでにリッスンしていることを示す `GatewayLockError` をスローします。

修正: 他のインスタンスを停止するか、ポートを解放するか、`openclaw gateway --port <port>` で実行してください。

### OpenClaw をリモートモードで実行するには（クライアントが別の Gateway に接続）？

`gateway.mode: "remote"` を設定してリモートの WebSocket URL を指定し、オプションでトークン/パスワードを追加します:

```json5
{
  gateway: {
    mode: "remote",
    remote: {
      url: "ws://gateway.tailnet:18789",
      token: "your-token",
      password: "your-password",
    },
  },
}
```

注意:

- `openclaw gateway` は `gateway.mode` が `local` の場合にのみ起動します（またはオーバーライドフラグを渡す）。
- macOS アプリは設定ファイルを監視し、これらの値が変更されるとライブでモードを切り替えます。

### Control UI が「unauthorized」と表示される（または再接続し続ける）。どうすれば？

Gateway は認証が有効（`gateway.auth.*`）で実行されていますが、UI が一致するトークン/パスワードを送信していません。

コードからの事実:

- Control UI はブラウザの localStorage キー `openclaw.control.settings.v1` にトークンを保存します。

修正:

- 最速: `openclaw dashboard`（ダッシュボード URL を表示してコピーし、開こうとします。ヘッドレスの場合は SSH のヒントを表示）。
- トークンがまだない場合: `openclaw doctor --generate-gateway-token`。
- リモートの場合は先にトンネルを張ります: `ssh -N -L 18789:127.0.0.1:18789 user@host`、次に `http://127.0.0.1:18789/` を開きます。
- Gateway ホストで `gateway.auth.token`（または `OPENCLAW_GATEWAY_TOKEN`）を設定します。
- Control UI の設定に同じトークンを貼り付けます。
- まだ詰まっている? `openclaw status --all` を実行して [トラブルシューティング](/gateway/troubleshooting) に従ってください。認証の詳細については [ダッシュボード](/web/dashboard) を参照してください。

### `gateway.bind: "tailnet"` を設定したがバインドできない / 何もリッスンしない

`tailnet` バインドはネットワークインターフェースから Tailscale IP を選択します（100.64.0.0/10）。マシンが Tailscale に接続されていない（またはインターフェースがダウンしている）場合、バインドするものがありません。

修正:

- そのホストで Tailscale を開始するか（100.x アドレスを取得するために）、
- `gateway.bind: "loopback"` / `"lan"` に切り替えます。

注意: `tailnet` は明示的です。`auto` はループバックを優先します。tailnet のみのバインドが必要な場合は `gateway.bind: "tailnet"` を使用してください。

### 同じホストで複数の Gateway を実行できますか？

通常はいいえ。1 つの Gateway が複数のメッセージングチャンネルとエージェントを実行できます。冗長性（例: レスキューボット）またはハードな分離が必要な場合にのみ複数の Gateway を使用してください。

はい、ただし以下を分離する必要があります:

- `OPENCLAW_CONFIG_PATH`（インスタンスごとの設定）
- `OPENCLAW_STATE_DIR`（インスタンスごとの状態）
- `agents.defaults.workspace`（ワークスペースの分離）
- `gateway.port`（固有のポート）

クイックセットアップ（推奨）:

- インスタンスごとに `openclaw --profile <name> …` を使用します（自動的に `~/.openclaw-<name>` を作成）。
- 各プロファイル設定で固有の `gateway.port` を設定します（または手動実行に `--port` を渡します）。
- プロファイルごとのサービスをインストールします: `openclaw --profile <name> gateway install`。

プロファイルはサービス名にもサフィックスを付けます（`ai.openclaw.<profile>`; レガシー `com.openclaw.*`、`openclaw-gateway-<profile>.service`、`OpenClaw Gateway (<profile>)`）。
完全なガイド: [複数の Gateway](/gateway/multiple-gateways)。

### 「invalid handshake」/ コード 1008 とはどういう意味ですか？

Gateway は **WebSocket サーバー**であり、最初のメッセージが `connect` フレームであることを期待します。それ以外のものを受信すると、**コード 1008**（ポリシー違反）で接続を閉じます。

よくある原因:

- WS クライアントではなくブラウザで **HTTP** URL（`http://...`）を開いた。
- 誤ったポートまたはパスを使用した。
- プロキシまたはトンネルが認証ヘッダーを削除するか、Gateway 以外のリクエストを送信した。

クイック修正:

1. WS URL を使用してください: `ws://<host>:18789`（または HTTPS の場合は `wss://...`）。
2. 通常のブラウザタブで WS ポートを開かないでください。
3. 認証が有効な場合は、`connect` フレームにトークン/パスワードを含めてください。

CLI または TUI を使用している場合、URL は以下のようになります:

```
openclaw tui --url ws://<host>:18789 --token <token>
```

プロトコルの詳細: [Gateway プロトコル](/gateway/protocol)。


## ログとデバッグ

### ログはどこにありますか？

ファイルログ（構造化）:

```
/tmp/openclaw/openclaw-YYYY-MM-DD.log
```

`logging.file` で安定したパスを設定できます。ファイルログレベルは `logging.level` で制御されます。コンソールの詳細度は `--verbose` と `logging.consoleLevel` で制御されます。

最速のログテール:

```bash
openclaw logs --follow
```

サービス/スーパーバイザーログ（Gateway が launchd/systemd 経由で実行される場合）:

- macOS: `$OPENCLAW_STATE_DIR/logs/gateway.log` と `gateway.err.log`（デフォルト: `~/.openclaw/logs/...`; プロファイルは `~/.openclaw-<profile>/logs/...` を使用）
- Linux: `journalctl --user -u openclaw-gateway[-<profile>].service -n 200 --no-pager`
- Windows: `schtasks /Query /TN "OpenClaw Gateway (<profile>)" /V /FO LIST`

詳細については [トラブルシューティング](/gateway/troubleshooting#log-locations) を参照してください。

### Gateway サービスを起動/停止/再起動するには？

Gateway ヘルパーを使用してください:

```bash
openclaw gateway status
openclaw gateway restart
```

Gateway を手動で実行している場合、`openclaw gateway --force` でポートを取り戻せます。[Gateway](/gateway) を参照してください。

### Windows でターミナルを閉じてしまいました。OpenClaw を再起動するには？

**2 つの Windows インストールモード**があります:

**1) WSL2（推奨）:** Gateway は Linux 内で実行されます。

PowerShell を開き、WSL に入り、再起動します:

```powershell
wsl
openclaw gateway status
openclaw gateway restart
```

サービスをインストールしていない場合は、フォアグラウンドで起動します:

```bash
openclaw gateway run
```

**2) ネイティブ Windows（推奨しません）:** Gateway は Windows 上で直接実行されます。

PowerShell を開いて実行します:

```powershell
openclaw gateway status
openclaw gateway restart
```

手動で実行している場合（サービスなし）は:

```powershell
openclaw gateway run
```

ドキュメント: [Windows（WSL2）](/platforms/windows)、[Gateway サービスランブック](/gateway)。

### Gateway は動作しているが返信が届かない。何を確認すべきですか？

クイックヘルスチェックから始めます:

```bash
openclaw status
openclaw models status
openclaw channels status
openclaw logs --follow
```

よくある原因:

- **Gateway ホスト**でモデル認証が読み込まれていない（`models status` を確認）。
- チャンネルペアリング/許可リストが返信をブロックしている（チャンネル設定 + ログを確認）。
- WebChat/ダッシュボードが正しいトークンなしで開いている。

リモートの場合は、トンネル/Tailscale 接続が確立されていて、Gateway の WebSocket に到達できることを確認してください。

ドキュメント: [チャンネル](/channels)、[トラブルシューティング](/gateway/troubleshooting)、[リモートアクセス](/gateway/remote)。

### 「Disconnected from gateway: no reason」。どうすれば？

通常、UI が WebSocket 接続を失ったことを意味します。確認してください:

1. Gateway が実行中ですか？`openclaw gateway status`
2. Gateway は健全ですか？`openclaw status`
3. UI に正しいトークンがありますか？`openclaw dashboard`
4. リモートの場合、トンネル/Tailscale リンクは確立されていますか？

次にログをテールします:

```bash
openclaw logs --follow
```

ドキュメント: [ダッシュボード](/web/dashboard)、[リモートアクセス](/gateway/remote)、[トラブルシューティング](/gateway/troubleshooting)。

### Telegram の setMyCommands がネットワークエラーで失敗します。何を確認すべきですか？

ログとチャンネルステータスから始めます:

```bash
openclaw channels status
openclaw channels logs --channel telegram
```

VPS またはプロキシの後ろにいる場合は、アウトバウンド HTTPS が許可されていて DNS が動作していることを確認してください。
Gateway がリモートの場合は、Gateway ホストのログを確認していることを確認してください。

ドキュメント: [Telegram](/channels/telegram)、[チャンネルトラブルシューティング](/channels/troubleshooting)。

### TUI に出力が表示されません。何を確認すべきですか？

まず Gateway が到達可能でエージェントが実行できることを確認します:

```bash
openclaw status
openclaw models status
openclaw logs --follow
```

TUI では `/status` を使用して現在の状態を確認してください。チャットチャンネルで返信を期待する場合は、配信が有効になっていることを確認してください（`/deliver on`）。

ドキュメント: [TUI](/web/tui)、[スラッシュコマンド](/tools/slash-commands)。

### Gateway を完全に停止してから起動するには？

サービスをインストールした場合:

```bash
openclaw gateway stop
openclaw gateway start
```

これにより**監視されたサービス**（macOS の launchd、Linux の systemd）が停止/起動されます。
Gateway がバックグラウンドデーモンとして実行されている場合に使用してください。

フォアグラウンドで実行している場合は Ctrl-C で停止し、次に:

```bash
openclaw gateway run
```

ドキュメント: [Gateway サービスランブック](/gateway)。

### わかりやすく説明: `openclaw gateway restart` vs `openclaw gateway`

- `openclaw gateway restart`: **バックグラウンドサービス**（launchd/systemd）を再起動します。
- `openclaw gateway`: このターミナルセッション用に**フォアグラウンド**で Gateway を実行します。

サービスをインストールした場合は gateway コマンドを使用してください。ワンオフのフォアグラウンド実行が必要な場合は `openclaw gateway` を使用してください。

### 何かが失敗したときに詳細を取得する最速の方法は？

`--verbose` で Gateway を起動してコンソールの詳細を増やしてください。次にログファイルでチャンネル認証、モデルルーティング、RPC エラーを調べてください。

## メディアと添付ファイル

### スキルで画像/PDF が生成されましたが、何も送信されませんでした

エージェントからのアウトバウンド添付ファイルには `MEDIA:<path-or-url>` 行（それだけで 1 行）が必要です。[OpenClaw アシスタントのセットアップ](/start/openclaw) と [エージェント送信](/tools/agent-send) を参照してください。

CLI での送信:

```bash
openclaw message send --target +15555550123 --message "Here you go" --media /path/to/file.png
```

以下も確認してください:

- ターゲットチャンネルがアウトバウンドメディアをサポートし、許可リストでブロックされていないこと。
- ファイルがプロバイダーのサイズ制限内であること（画像は最大 2048px にリサイズされます）。

[画像](/nodes/images) を参照してください。

## セキュリティとアクセス制御

### OpenClaw を受信 DM に公開するのは安全ですか？

受信 DM は信頼できない入力として扱ってください。デフォルトはリスクを減らすように設計されています:

- DM 対応チャンネルのデフォルト動作は**ペアリング**です:
  - 不明な送信者はペアリングコードを受け取ります。ボットはメッセージを処理しません。
  - 以下で承認します: `openclaw pairing approve --channel <channel> [--account <id>] <code>`
  - 保留中のリクエストはチャンネルごとに **3 つ**に制限されています。コードが届かない場合は `openclaw pairing list --channel <channel> [--account <id>]` を確認してください。
- DM を公開するには明示的なオプトインが必要です（`dmPolicy: "open"` と許可リスト `"*"`）。

リスクのある DM ポリシーを見つけるには `openclaw doctor` を実行してください。

### プロンプトインジェクションは公開ボットだけの問題ですか？

いいえ。プロンプトインジェクションは**信頼できないコンテンツ**に関することであり、ボットに DM できる人だけの問題ではありません。
アシスタントが外部コンテンツ（Web 検索/フェッチ、ブラウザのページ、メール、ドキュメント、添付ファイル、貼り付けたログ）を読む場合、そのコンテンツにはモデルを乗っ取ろうとする指示が含まれる可能性があります。**あなたが唯一の送信者**であっても発生する可能性があります。

最大のリスクはツールが有効な場合です。モデルはコンテキストを外部に漏洩させたり、あなたの代わりにツールを呼び出すよう騙される可能性があります。リスクの範囲を減らすには:

- 信頼できないコンテンツを要約するために読み取り専用またはツール無効の「リーダー」エージェントを使用する
- ツール対応エージェントには `web_search` / `web_fetch` / `browser` をオフにする
- サンドボックスと厳格なツール許可リスト

詳細: [セキュリティ](/gateway/security)。

### ボットには独自のメール、GitHub アカウント、電話番号が必要ですか？

ほとんどのセットアップでははい。ボットを別のアカウントと電話番号で分離することで、何か問題が発生した場合の影響範囲を減らします。また、個人アカウントに影響を与えずにクレデンシャルをローテーションしたりアクセスを取り消したりしやすくなります。

小さく始めてください。実際に必要なツールとアカウントへのアクセスのみを与え、必要に応じて後で拡張してください。

ドキュメント: [セキュリティ](/gateway/security)、[ペアリング](/channels/pairing)。

### テキストメッセージに対して自律性を与えることはできますか？安全ですか？

個人メッセージへの完全な自律性は**推奨しません**。最も安全なパターンは:

- DM を**ペアリングモード**または厳格な許可リストに保つ。
- あなたの代わりにメッセージを送らせたい場合は**別の番号またはアカウント**を使用する。
- 草稿を作成させ、送信前に**承認する**。

実験したい場合は専用アカウントで行い、分離を維持してください。
[セキュリティ](/gateway/security) を参照してください。

### 個人アシスタントタスクに安価なモデルを使用できますか？

エージェントがチャットのみで入力が信頼できる**場合は**はい。小さなティアは命令ハイジャックに対してより脆弱なため、ツール対応エージェントや信頼できないコンテンツを読む場合は避けてください。小さなモデルを使用しなければならない場合は、ツールをロックダウンしてサンドボックス内で実行してください。[セキュリティ](/gateway/security) を参照してください。

### Telegram で `/start` を実行しましたが、ペアリングコードが届きませんでした

ペアリングコードは不明な送信者がボットにメッセージを送り、`dmPolicy: "pairing"` が有効な場合に**のみ**送信されます。`/start` だけではコードは生成されません。

保留中のリクエストを確認してください:

```bash
openclaw pairing list telegram
```

即座のアクセスが必要な場合は、送信者 ID を許可リストに追加するか、そのアカウントに `dmPolicy: "open"` を設定してください。

### WhatsApp: 連絡先にメッセージを送りますか？ペアリングはどのように機能しますか？

いいえ。デフォルトの WhatsApp DM ポリシーは**ペアリング**です。不明な送信者はペアリングコードのみを受け取り、メッセージは**処理されません**。OpenClaw は受信したチャットにのみ、またはあなたがトリガーした明示的な送信にのみ返信します。

以下でペアリングを承認します:

```bash
openclaw pairing approve whatsapp <code>
```

保留中のリクエストをリストします:

```bash
openclaw pairing list whatsapp
```

ウィザードの電話番号プロンプト: これは**許可リスト/オーナー**を設定するために使用されます。自分自身の DM が許可されるようにするためです。自動送信には使用されません。個人の WhatsApp 番号で実行する場合は、その番号を使用して `channels.whatsapp.selfChatMode` を有効にしてください。

## チャットコマンド、タスクの中断、「止まらない」

### 内部システムメッセージをチャットに表示されないようにするには？

ほとんどの内部またはツールメッセージは、そのセッションで**verbose** または**reasoning** が有効な場合にのみ表示されます。

表示されているチャットで修正します:

```
/verbose off
/reasoning off
```

まだノイズが多い場合は Control UI のセッション設定を確認し、verbose を**inherit** に設定してください。設定で `verboseDefault` が `on` に設定されたボットプロファイルを使用していないことも確認してください。

ドキュメント: [思考と verbose](/tools/thinking)、[セキュリティ](/gateway/security#reasoning--verbose-output-in-groups)。

### 実行中のタスクを停止/キャンセルするには？

これらのいずれかを**スタンドアロンメッセージ**として送信してください（スラッシュなし）:

```
stop
stop action
stop current action
stop run
stop current run
stop agent
stop the agent
stop openclaw
openclaw stop
stop don't do anything
stop do not do anything
stop doing anything
please stop
stop please
abort
esc
wait
exit
interrupt
```

これらは中断トリガーです（スラッシュコマンドではありません）。

exec ツールからのバックグラウンドプロセスの場合は、エージェントに以下を実行させることができます:

```
process action:kill sessionId:XXX
```

スラッシュコマンドの概要: [スラッシュコマンド](/tools/slash-commands) を参照してください。

ほとんどのコマンドは `/` で始まる**スタンドアロン**メッセージとして送信する必要がありますが、一部のショートカット（`/status` など）は許可リストの送信者向けにインラインでも動作します。

### Telegram から Discord にメッセージを送るには？（「Cross-context messaging denied」）

OpenClaw はデフォルトで**クロスプロバイダー**メッセージングをブロックします。ツール呼び出しが Telegram にバインドされている場合、明示的に許可しない限り Discord には送信されません。

エージェントのクロスプロバイダーメッセージングを有効にします:

```json5
{
  agents: {
    defaults: {
      tools: {
        message: {
          crossContext: {
            allowAcrossProviders: true,
            marker: { enabled: true, prefix: "[from {channel}] " },
          },
        },
      },
    },
  },
}
```

設定を編集した後に Gateway を再起動してください。特定のエージェントにのみ適用したい場合は、代わりに `agents.list[].tools.message` 以下に設定してください。

### ボットが連続したメッセージを「無視」しているように感じるのはなぜですか？

キューモードは新しいメッセージが実行中の作業とどのように相互作用するかを制御します。`/queue` を使用してモードを変更してください:

- `steer` - 新しいメッセージが現在のタスクをリダイレクト
- `followup` - メッセージを一度に 1 つずつ実行
- `collect` - メッセージをまとめて一度に返信（デフォルト）
- `steer-backlog` - 今すぐステアリングし、バックログを処理
- `interrupt` - 現在の実行を中断して新しく開始

フォローアップモードには `debounce:2s cap:25 drop:summarize` などのオプションを追加できます。

## スクリーンショット/チャットログの質問に正確に答える

**Q: 「Anthropic で API キーを使用した場合のデフォルトモデルは何ですか？」**

**A:** OpenClaw では、クレデンシャルとモデルの選択は別々です。`ANTHROPIC_API_KEY` の設定（または認証プロファイルへの Anthropic API キーの保存）により認証は有効になりますが、実際のデフォルトモデルは `agents.defaults.model.primary`（例: `anthropic/claude-sonnet-4-5` または `anthropic/claude-opus-4-6`）で設定するものです。`No credentials found for profile "anthropic:default"` が表示される場合は、Gateway が実行しているエージェントの期待される `auth-profiles.json` で Anthropic のクレデンシャルを見つけられなかったことを意味します。

---

まだ詰まっていますか？[Discord](https://discord.com/invite/clawd) で質問するか、[GitHub ディスカッション](https://github.com/openclaw/openclaw/discussions) を開いてください。
