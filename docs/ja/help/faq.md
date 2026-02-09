---
summary: "OpenClaw のセットアップ、設定、使用方法に関するよくある質問"
title: "よくある質問"
---

# よくある質問

迅速な回答に加えて、現実世界のセットアップ(ローカル開発者、VPS、マルチエージェント、OAuth/APIキー、モデルフェイルオーバー)のトラブルシューティングも深めています。 ランタイム診断については、 [Troubleshooting](/gateway/troubleshooting) を参照してください。 完全な設定参照については、 [Configuration](/gateway/configuration) を参照してください。

## 目次

- [クイックスタートと初回セットアップ]
  - [詰まっています。最速で抜け出す方法は？](#im-stuck-whats-the-fastest-way-to-get-unstuck)
  - [OpenClaw をインストールしてセットアップする推奨方法は？](#whats-the-recommended-way-to-install-and-set-up-openclaw)
  - [オンボーディング後にダッシュボードを開くには？](#how-do-i-open-the-dashboard-after-onboarding)
  - [localhost とリモートで、ダッシュボードの認証（トークン）はどう違いますか？](#how-do-i-authenticate-the-dashboard-token-on-localhost-vs-remote)
  - [必要なランタイムは？](#what-runtime-do-i-need)
  - [Raspberry Pi で動きますか？](#does-it-run-on-raspberry-pi)
  - [Raspberry Pi へのインストールのコツはありますか？](#any-tips-for-raspberry-pi-installs)
  - [それは「私の友人を目覚めさせる」/オンボーディングは孵化しませんでした。 今何ですか?](#it-is-stuck-on-wake-up-my-friend-onboarding-will-not-hatch-what-now)
  - [オンボーディングをやり直さずに新しいマシン（Mac mini）へ移行できますか？](#can-i-migrate-my-setup-to-a-new-machine-mac-mini-without-redoing-onboarding)
  - [最新バージョンの変更点はどこで確認できますか？](#where-do-i-see-what-is-new-in-the-latest-version)
  - [Docs.openclaw.ai(SSLエラー)にアクセスできません。 今何ですか?](#i-cant-access-docsopenclawai-ssl-error-what-now)
  - [stable と beta の違いは何ですか？](#whats-the-difference-between-stable-and-beta)
  - [beta 版のインストール方法と、beta と dev の違いは？](#how-do-i-install-the-beta-version-and-whats-the-difference-between-beta-and-dev)
  - [最新のビルドを試すには？](#how-do-i-try-the-latest-bits)
  - [インストールとオンボーディングには通常どれくらいかかりますか？](#how-long-does-install-and-onboarding-usually-take)
  - [Installer stuck? もっとフィードバックを得るにはどうすればいいですか?](#installer-stuck-how-do-i-get-more-feedback)
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
  - [OpenClawとは何ですか?] (#what-is-openclaw-in-one-paragraph)
  - [価値提案は何ですか？](#whats-the-value-proposition)
  - [最初に何をすべきかを設定しました](#i-just-set-it-up-what-should-i-do-first)
  - [OpenClaw の日常的なトップ 5 のユースケースは何ですか](#what-are-the-top-five-everyday-use-cases-for-openclaw)
  - [OpenClaw は SaaS 向けのリード獲得アウトリーチ広告やブログに役立ちますか](#can-openclaw-help-with-lead-gen-outreach-ads-and-blogs-for-a-saas)
  - [ウェブ開発におけるクロード・コードに対する利点は何ですか?](#what-are-the-advantages-vs-claude-code-for-web-development)
- [Skills と自動化](#skills-and-automation)
  - [リポジトリを汚さずにスキルをカスタマイズするには？](#how-do-i-customize-skills-without-keeping-the-repo-dirty)
  - [カスタムフォルダからスキルを読み込むことはできますか?](#can-i-load-skills-from-a-custom-folder)
  - [異なるタスクに異なるモデルをどのように使用できますか?](#how-can-i-use-different-models-for-different-tasks)
  - [The bot freezes while do heading work. [ボットが重い仕事をしながらフリーズする。 どうすればそれをオフロードできますか?](#the-bot-freezes-while-doing-heavy-work-how-do-i-offload-that)
  - [Cronまたはリマインダーは発火しません。 何をチェックすればいいですか?](#cron-or-reminders-do-not-fire-what-should-i-check)
  - [Linux にスキルをインストールするにはどうすればいいですか?](#how-do-i-install-skills-on-linux)
  - [OpenClaw はスケジュール実行やバックグラウンドでの継続実行ができますか？](#can-openclaw-run-tasks-on-a-schedule-or-continuously-in-the-background)
  - [Apple macOSのみのスキルをLinuxから実行できますか?](#can-i-run-apple-macos-only-skills-from-linux)
  - [Notion か HeyGen 統合がありますか？] (#do-you-have-a-notion-or-heygen-integration)
  - [ブラウザの乗っ取りにChrome拡張機能をインストールするにはどうすればいいですか?](#how-do-i-install-the-chrome-extension-for-browser-takeover)
- [サンドボックスとメモリ](#sandboxing-and-memory)
  - [専用のサンドボックス作成ドキュメントはありますか?](#is-there-a-dedicated-sandboxing-doc)
  - [ホストフォルダを Sandbox にバインドするにはどうすればよいですか?](#how-do-i-bind-a-host-folder-into-the-sandbox)
  - [メモリはどのように動作しますか?](#how-does-memory-work)
  - [記憶は物事を忘れ続ける] スティックを作るにはどうすればいいですか?](#memory-keeps-forgetting-things-how-do-i-make-it-stick)
  - [メモリは永遠に持続しますか? 限界は何ですか?](#does-memory-persist-forever-what-are-the-limits)
  - [Semantic memory search requires an OpenAI API key?](#does-semantic-memory-search-require-an-openai-api-key)
- [ディスク上の配置](#where-things-live-on-disk)
  - [OpenClawのデータはすべてローカルに保存されますか?](#is-all-data-used-with-openclaw-saved-locally)
  - [OpenClaw のデータはどこに保存されますか？](#where-does-openclaw-store-its-data)
  - [AGENTS.md / SOUL.md / USER.md / MEMORY.md live?](#where-should-agentsmd-soulmd-usermd-memorymd-live)
  - [推奨されるバックアップ戦略は何ですか?](#whats-the-recommended-backup-strategy)
  - [どうすればOpenClawを完全にアンインストールできますか?](#how-do-i-completely-uninstall-openclaw)
  - [エージェントはワークスペース外で動作できますか？](#can-agents-work-outside-the-workspace)
  - [I in remote mode - where the session store?](#im-in-remote-mode-where-is-the-session-store)
- [設定の基本](#config-basics)
  - [設定のフォーマットは? どこにありますか?](#what-format-is-the-config-where-is-it)
  - [`gateway.bind: "lan"` (または `"tailnet"`)を設定し、現在は何もリッスンせず/UIが許可されていない](#i-set-gatewaybind-lan-or-tailnet-and-now-nothing-listens-the-ui-says-unauthorized)
  - [なぜ localhost にトークンが必要なのですか?](#why-do-i-need-a-token-on-localhost-now)
  - [設定を変更してから再起動する必要がありますか?](#do-i-have-to-restart-after-changing-config)
  - [Web 検索(および Web フェッチ)を有効にするにはどうすればいいですか?](#how-do-i-enable-web-search-and-web-fetch)
  - [config.apply ]設定を消去しました。 これを回避するにはどうすればいいですか?](#configapply-wiped-my-config-how-do-i-recover-and-avoid-this)
  - [デバイス間で専門的なワーカーを使用して中央ゲートウェイを実行するにはどうすればよいですか?](#how-do-i-run-a-central-gateway-with-specialized-workers-across-devices)
  - [OpenClawブラウザはヘッドレスで動作できますか?](#can-the-openclaw-browser-run-headless)
  - [ブラウザ操作に Brave を使うには？](#how-do-i-use-brave-for-browser-control)
- [リモート Gateway とノード](#remote-gateways-and-nodes)
  - [Telegram、ゲートウェイ、ノード間でコマンドが伝播するにはどうすればよいですか?](#how-do-commands-propagate-between-telegram-the-gateway-and-nodes)
  - [ゲートウェイがリモートホストされている場合、エージェントはどうやってコンピュータにアクセスできますか?](#how-can-my-agent-access-my-computer-if-the-gateway-is-hosted-remotely)
  - [Tailscale is connected but I get no replies. [Tailscale is connected but I get no replies(私は返信を得ない。 今何ですか?](#tailscale-is-connected-but-i-get-no-replies-what-now)
  - [2 つの OpenClawインスタンスが互いに通信できますか(ローカル + VPS)?](#can-two-openclaw-instances-talk-to-each-other-local-vps)
  - [複数エージェントに別々の VPS は必要ですか](#do-i-need-separate-vpses-for-multiple-agents)
  - [VPSからSSHではなく個人用ラップトップでノードを使用するメリットはありますか?](#is-there-a-benefit-to-using-a-node-on-my-personal-laptop-instead-of-ssh-from-a-vps)
  - [ノードはゲートウェイサービスを実行しますか?] (#do-nodes-run-a-gateway-service)
  - [設定を適用するAPI/RPC方法はありますか?](#is-there-an-api-rpc-way-to-apply-config)
  - [最初のインストールで最小限の "正しい" 設定とは何ですか?](#whats-a-minimal-sane-config-for-a-first-install)
  - [TailscaleをVPSに設定し、Macから接続するにはどうすればいいですか?](#how-do-i-set-up-tailscale-on-a-vps-and-connect-from-my-mac)
  - [Mac ノードをリモートゲートウェイ(Tailscale Serve)に接続するにはどうすればいいですか?](#how-do-i-connect-a-mac-node-to-a-remote-gateway-tailscale-serve)
  - [2 台目のラップトップにインストールするか、ノードを追加する必要がありますか?](#should-i-install-on-a-second-laptop-or-just-add-a-node)
- [環境変数と .env の読み込み](#env-vars-and-env-loading)
  - [OpenClawの環境変数はどのようにロードされますか?](#how-does-openclaw-load-environment-variables)
  - ["私はサービス経由でゲートウェイを開始し、私のEnv varsが消えました。 今何ですか?](#i-started-the-gateway-via-the-service-and-my-env-vars-disappeared-what-now)
  - [`COPILOT_GITHUB_TOKEN` に設定しましたが、モデルの状態は "Shell env: off" になります。 なぜですか?](#i-set-copilotgithubtoken-but-models-status-shows-shell-env-off-why)
- [セッションと複数チャット](#sessions-and-multiple-chats)
  - [How do I start a new conversation?](#how-do-i-start-a-fresh-conversation)
  - [`/new`を送信しないとセッションが自動的にリセットされますか？]（#do-sessions-reset-automatically-if-i-never-send-new）
  - [OpenClaw インスタンスの 1 つの CEO と多くのエージェントのチームを作る方法はありますか](#is-there-a-way-to-make-a-team-of-openclaw-instances-one-ceo-and-many-agents)
  - [なぜコンテキストが途中で切り捨てられたのでしょうか? どうすれば防げますか?](#why-did-context-get-truncated-midtask-how-do-i-prevent-it)
  - [OpenClawを完全にリセットするにはどうすればいいですか?](#how-do-i-completely-reset-openclaw-but-keep-it-installed)
  - [コンテキストが大きすぎます。リセットまたはコンパクトにするにはどうすればいいですか？](#im-getting-context-too-large-errors-how-do-i-reset-or-compact)
  - [なぜ LLM リクエストが拒否されましたか? messages.N.content.X.tool_use.input: フィールドが必要です"?](#why-am-i-seeing-llm-request-rejected-messagesncontentxtooluseinput-field-required)
  - [なぜ 30 分おきにハートビートのメッセージを受け取るのですか?](#why-am-i-getting-heartbeat-messages-every-30-minutes)
  - [WhatsAppグループに「ボットアカウント」を追加する必要がありますか？](#do-i-need-to-add-a-bot-account-to-a-whatsapp-group)
  - [WhatsAppグループのJIDを取得するにはどうすればいいですか?](#how-do-i-get-the-jid-of-a-whatsapp-group)
  - [Why doesn't OpenClaw reply in a group?](#why-doesnt-openclaw-reply-in-a-group)
  - [グループ/スレッドはDMとコンテキストを共有しますか?](#do-groupsthreads-share-context-with-dms)
  - [How many workspaces and agents can I create?](#how-many-workspaces-and-agents-can-i-create)
  - [複数のボットやチャットを同時に実行できますか(Slack)、そしてどのように設定すればいいですか?](#can-i-run-multiple-bots-or-chats-at-the-same-time-slack-and-how-should-i-set-that-up)
- [モデル: デフォルト、選択、エイリアス、切り替え](#models-defaults-selection-aliases-switching)
  - [デフォルトモデルとは?](#what-is-the-default-model)
  - [What model do you recommend?](#what-model-do-you-recommend)
  - [設定を消さずにモデルを切り替えるにはどうすればいいですか?](#how-do-i-switch-models-without-wiping-my-config)
  - [自己ホストモデル(llama.cpp, vLLM, Ollama)を使用できますか?](#can-i-use-selfhosted-models-llamacpp-vllm-ollama)
  - [OpenClaw、Flawd、およびKrillがモデルに何を使用するか?](#what-do-openclaw-flawd-and-krill-use-for-models)
  - [モデルをオンザフライで(再起動せずに)切り替えるにはどうすればいいですか?](#how-do-i-switch-models-on-the-fly-without-restarting)
  - [毎日のタスクにGPT 5.2を、コーディングにコーデック5.3を使用できます](#can-i-use-gpt-52-for-daily-tasks-and-codex-53-for-coding)
  - [Why do I see "Model … は許可されていません。そして返信しませんか？](#why-do-i-see-model-is-not-allowed-and-then-no-reply)
  - [Unknown model: minimax/MiniMax-M2.1"が表示されるのはなぜですか?](#why-do-i-see-unknown-model-minimaxminimaxm21)
  - [MiniMax をデフォルトとして、OpenAI を複雑なタスクに使用できますか?](#can-i-use-minimax-as-my-default-and-openai-for-complex-tasks)
  - [opus / sonnet / gpt 組み込みショートカットはありますか?](#are-opus-sonnet-gpt-builtin-shortcuts)
  - [モデルショートカットを定義/オーバーライドするにはどうすればいいですか?](#how-do-i-defineoverride-model-shortcuts-aliases)
  - [OpenRouterやZ.AIなどの他のプロバイダからモデルを追加するにはどうすればいいですか?](#how-do-i-add-models-from-other-providers-like-openrouter-or-zai)
- [モデルのフェイルオーバーと「All models failed」](#model-failover-and-all-models-failed)
  - [フェイルオーバーはどのように動作しますか?](#how-does-failover-work)
  - [このエラーはどういう意味ですか?](#what-does-this-error-mean)
  - [Fix checklist for `No credentials for profile "anthropic:default"`](#fix-checklist-for-no-credentials-found-for-profile-anthropicdefault)
  - [なぜグーグルジェミニも試して失敗したのか?](#why-did-it-also-try-google-gemini-and-fail)
- [認証プロファイル: 概要と管理方法](#auth-profiles-what-they-are-and-how-to-manage-them)
  - [認証プロファイルとは何ですか?](#what-is-an-auth-profile)
  - [What are typical profile IDs?](#what-are-typical-profile-ids)
  - [どの認証プロファイルが最初に試されるかを制御できますか?](#can-i-control-which-auth-profile-is-tried-first)
  - [OAuth vs API キー: 違いは何ですか?](#oauth-vs-api-key-whats-the-difference)
- [Gateway: ポート、「すでに実行中」、リモートモード](#gateway-ports-already-running-and-remote-mode)
  - [What port does the Gateway use?](#what-port-does-the-gateway-use)
  - [`openclaw gateway status` は `Runtime: running` と `RPCprobe: failed` と言うのはなぜですか？](#why-does-openclaw-gateway-status-say-runtime-running-but-rpc-probe-failed)
  - [`openclaw gateway status` が `Config (cli)` と `Config (service)` と異なるのはなぜですか？](#why-does-openclaw-gateway-status-show-config-cli-and-config-service-different)
  - ["別のゲートウェイインスタンスが既にリッスンしている"とはどういう意味ですか?](#what-does-another-gateway-instance-is-already-listening-mean)
  - [リモートモードでOpenClawを実行するにはどうすればよいですか(クライアントはどこか他のゲートウェイに接続します)?](#how-do-i-run-openclaw-in-remote-mode-client-connects-to-a-gateway-elsewhere)
  - [Control UI が「許可されていない」(または再接続を続ける)と表示されます。 今何ですか?](#the-control-ui-says-unauthorized-or-keeps-reconnecting-what-now)
  - [`gateway.bind: "tailnet"`に設定しましたが、バインドできません/何もリッスンできません](#i-set-gatewaybind-tailnet-but-it-cant-bind-nothing-listens)
  - [同じホストで複数のゲートウェイを実行できますか?](#can-i-run-multiple-gateways-on-the-same-host)
  - [無効なハンドシェイク/コード 1008 はどういう意味ですか？](#what-does-invalid-handshake-code-1008-mean)
- [ログとデバッグ](#logging-and-debugging)
  - [Where are logs?](#where-are-logs)
  - [ゲートウェイサービスを開始/停止/再起動するにはどうすればよいですか?](#how-do-i-startstoprestart-the-gateway-service)
  - [Windows 上で端末を閉じました - どうやってOpenClawを再起動しますか?](#i-closed-my-terminal-on-windows-how-do-i-restart-openclaw)
  - [ゲートウェイは稼働していますが、応答が届きません。 何をチェックすればいいですか?](#the-gateway-is-up-but-replies-never-arrive-what-should-i-check)
  - ["ゲートウェイから切断されました: 理由なし" - 今何ですか?](#disconnected-from-gateway-no-reason-what-now)
  - [Telegram setMyCommands fails with network errors. 何をチェックすればいいですか?](#telegram-setmycommands-fails-with-network-errors-what-should-i-check)
  - [TUI は出力を表示しません。 何をチェックすればいいですか?](#tui-shows-no-output-what-should-i-check)
  - [ゲートウェイを完全に停止するにはどうすればいいですか？](#how-do-i-completely-stop-then-start-the-gateway)
  - [ELI5: `openclaw gateway restart` vs `openclaw gateway`](#eli5-openclaw-gateway-restart-vs-openclaw-gateway)
  - [何かが失敗したときに詳細を取得する最速の方法は何ですか?](#whats-the-fastest-way-to-get-more-details-when-something-fails)
- [メディアと添付ファイル](#media-and-attachments)
  - [My skill generated an image/PDF, but nothing was sent](#my-skill-generated-an-imagepdf-but-nothing-was-sent)
- [セキュリティとアクセス制御](#security-and-access-control)
  - [OpenClawをインバウンドDMに公開しても安全ですか?](#is-it-safe-to-expose-openclaw-to-inbound-dms)
  - [プロンプトインジェクションはパブリックボットの関心だけですか?](#is-prompt-injection-only-a-concern-for-public-bots)
  - [Should my bot have its own email GitHub account or phone number](#should-my-bot-have-its-own-email-github-account-or-phone-number)
  - [Can I give it autonomy over my text messages and is that safe](#can-i-give-it-autonomy-over-my-text-messages-and-is-that-safe)
  - [パーソナルアシスタントに安価なモデルを使用できますか?](#can-i-use-cheaper-models-for-personal-assistant-tasks)
  - [Telegram で `/start` を実行しましたが、ペアリングコードが見つかりませんでした](#i-ran-start-in-telegram-but-didnt-get-a-pairing-code)
  - [WhatsApp:それは私の連絡先にメッセージを送信しますか? ペアリングはどのように機能しますか?](#whatsapp-will-it-message-my-contacts-how-does-pairing-work)
- [チャットコマンド、タスク中断、「止まらない」問題](#chat-commands-aborting-tasks-and-it-wont-stop)
  - [How do I stop internal system messages from showing in chat](#how-do-i-stop-internal-system-messages-from-showing-in-chat)
  - [実行中のタスクを停止/キャンセルするにはどうすればいいですか?](#how-do-i-stopcancel-a-running-task)
  - [TelegramからDiscordメッセージを送信するにはどうすればいいですか？ ("Cross-context messaging denied")](#how-do-i-send-a-discord-message-from-telegram-crosscontext-messaging-denied)
  - [ボットが素早い発火メッセージを「無視」するのはなぜですか？]（#why-does-it-feel-like-the-bot-ignores-rapidfire-messages）

## もし何かが壊れている場合、最初の60秒

1. **クイックステータス（最初のチェック）**

   ```bash
   openclaw status
   ```

   Fast local summary: OS + update, gateway/service reachability, agents/sessions, provider config + runtime issues (ゲートウェイに到達可能な場合).

2. **貼り付け可能なレポート (安全に共有できます)**

   ```bash
   openclawの状態 --all
   ```

   ログテール付きの読み取り専用の診断 (トークンが削除されました)。

3. **デーモン+ポート状態**

   ```bash
   openclaw gateway status
   ```

   スーパーバイザランタイム対RPC到達性、プローブターゲットURL、およびおそらく使用されているサービスの設定を表示します。

4. **Deep probes**

   ```bash
   openclawの状態 --deep
   ```

   ゲートウェイのヘルスチェック+プロバイダプローブを実行します (到達可能なゲートウェイが必要です)。 [Health](/gateway/health) を参照してください。

5. **最新のログを記録**

   ```bash
   openclaw logs --follow
   ```

   RPCがダウンした場合は、以下に戻ります：

   ```bash
   tail -f "$(ls -t /tmp/openclaw/openclaw-*.log | head -1)"
   ```

   ファイルログはサービスログとは別のものです; [Logging](/logging) と [Troubleshooting](/gateway/troubleshooting) を参照してください。

6. **医師を実行（修理）**

   ```bash
   openclaw doctor
   ```

   Repairs/migrates config/state + はヘルスチェックを実行します。 [Doctor](/gateway/doctor) を参照してください。

7. **Gateway snapshot**

   ```bash
   openclaw health --json
   openclaw health --verbose # エラー時にターゲット URL + config pathを表示する
   ```

   フルスナップショット(WSのみ)の実行中のゲートウェイに尋ねます。 [Health](/gateway/health) を参照してください。

## クイックスタートと初回セットアップ

### イムはスタックを解除するための最速の方法をスタックしました

**マシンを見る**ことができるローカルAIエージェントを使用してください。 That is far more effective than asking
in Discord, because most "I'm stuck" cases are **local config or environment issues** that
remote helpers cannot inspect.

- **クロードコード**: [https://www.anthropic.com/claude-code/](https://www.anthrop.com/claude-code/)
- **OpenAI Codex**: [https://openai.com/codex/](https://openai.com/codex/)

これらのツールはリポジトリの読み取り、コマンドの実行、ログの検査、マシンレベルの
のセットアップ(PATH、サービス、権限、認証ファイル)の修正に役立ちます。 Hackable (git) インストールの
を介して **完全なソースチェックアウト** を与えます:

```bash
curl -fsSL https://openclaw.ai/install.sh | bash -s -- --install-method git
```

GitチェックアウトからOpenClawをインストールします。 エージェントは、実行している正確なバージョンについて、コード+ドキュメントと
の理由を読むことができます。 `--install-method git` を使わずにインストーラを再実行することで、後で安定した
に切り替えることができます。

ヒント：エージェントに **計画を立てて監督** してもらい（ステップバイステップ）、そして
必要なコマンドのみを実行してください。 それは変化を小さく、監査を容易に保ちます。

もし本当のバグや修正が見つかったら、GitHubの問題を報告するか、PRを送ってください:
[https://github.com/openclaw/openclaw/issues](https://github.com/openclaw/openclaw/issues)
[https://github.com/openclaw/openclaw/pulls](https://github.com/openclaw/openclaw/pulls)

以下のコマンドから開始します(ヘルプを求めるときに出力を共有します):

```bash
openclaw状態
openclawモデル状態
openclaw doctor
```

何をしているのか:

- `openclaw status`: gateway/agent health + basic configのクイックスナップショット。
- `openclawモデルの状態`: プロバイダの認証+モデルの可用性をチェックします。
- `openclaw doctor`: 一般的な設定/状態の問題を検証および修復します。

その他の便利な CLI のチェック: `openclaw status --all` 、 `openclaw logs --follow` 、
`openclaw gateway status` 、 `openclaw health --verbose` 。

クイックデバッグループ: [何かが壊れたら最初の60秒](#first-60-seconds-if-somethings-broken)。
docsをインストール: [Install](/install), [Installer flags](/install/installer), [Updating](/install/updating).

### OpenClawのインストールとセットアップの推奨方法は？

リポジトリは、ソースから実行し、オンボーディングウィザードを使用することをお勧めします。

```bash
curl -fsSL https://openclaw.ai/install.sh | bash
openclawon --install-daemon
```

ウィザードはUIアセットを自動的にビルドすることもできます。 搭乗後は通常、ゲートウェイを**18789**ポートで実行します。

ソースから (貢献者/開発者):

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
pnpm install
pnpm build
pnpm ui:build # auto-installs UI deps on first run
openclawオン
```

グローバルインストールがまだない場合は、`pnpm openclaw onboard` で実行してください。

### オンボーディング後にダッシュボードを開く方法

ウィザードは、オンボーディング直後にクリーン(トークン化されていない)ダッシュボードURLでブラウザを開き、概要にリンクを出力します。 そのタブを開いたままにしておきます。起動しなかった場合は、同じマシンに印刷された URL をコピー/貼り付けます。

### ダッシュボードトークンをlocalhostとリモートで認証する方法

**Localhost (同じマシン):**

- `http://127.0.0.1:18789/`を開きます。
- authを要求する場合は、`gateway.auth.token` (または `OPENCLAW_GATEWAY_TOKEN` ) からトークンをControl UI 設定に貼り付けます。
- ゲートウェイ ホストから取得します: `openclaw config get gate gateway.auth.token` (または 1 つを生成: `openclaw doctor --generate-gateway-token` )。

**localhostにはありません:**

- **tailscale Serve** (推奨): バインドループバックを維持し、`openclaw gateway --tailscale serve`を実行し、`https://<magicdns> /`を開きます。 `gateway.auth.allowTailscale` が `true` の場合、アイデンティティヘッダーは auth (トークンなし) を満たします。
- **Tailnet bind**: run `openclaw gateway --bindtailnet --token "<token>"`, open `http://<tailscale-ip>:18789/`, paste token
- **SSHトンネル**: `ssh -N -L 18789:127.0.0.1:18789 user@host`を開き、`http://127.0.0.1:18789/`を開き、Control UI設定でトークンを貼り付けます。

バインドモードと認証の詳細については、 [Dashboard](/web/dashboard) と [Web サーフェス](/web) を参照してください。

### どのランタイムが必要ですか？

ノード\*\*>= 22**が必要です。 `pnpm` をお勧めします。 Bun is not recommended** for the Gateway.

### Raspberry Pi で実行しますか？

はい ゲートウェイは軽量でドキュメントリスト**512MB-1GB RAM**、**1コア**です そして、約**500MB**
のディスクを個人的に使用することができます。**Raspberry Pi 4はそれを実行することができます**。

余分なヘッドルーム（ログ、メディア、その他のサービス）が必要な場合は**2GBをお勧めします**が、
難しい最小値ではありません。

ヒント: Pi/VPSはゲートウェイをホストすることができます。また、**ノード**をラップトップ/電話で
ローカルスクリーン/カメラ/キャンバスまたはコマンド実行用にペアリングすることができます。 [Nodes](/nodes) を参照してください。

### Raspberry Pi がインストールするためのヒント

短いバージョン:それは動作しますが、大まかなエッジを期待してください。

- **64ビット** OSを使用し、ノード>= 22を維持します。
- **hackable (git) インストール**を好むので、ログを見ることができ、更新が速くなります。
- チャネル/スキルなしで開始し、それらを1つずつ追加します。
- もしあなたが変なバイナリ問題に遭遇した場合、通常は **ARM 互換** の問題になります。

ドキュメント: [Linux](/platforms/linux), [Install](/install).

### それは私の友人のオンボーディングは孵化しません目を覚ます上で立ち往生している 今何を今

この画面はゲートウェイが到達可能で認証されていることによって異なります。 TUIはまた、最初のハッチに
を自動的に送信します。 **返信がない**
の行が表示され、トークンが0のままになった場合、エージェントは決して実行しません。

1. ゲートウェイを再起動:

```bash
openclaw gateway restart
```

2. ステータスの確認 + 認証:

```bash
openclaw status
openclaw models status
openclaw logs --follow
```

3. まだハングアップしている場合は、以下を実行してください。

```bash
openclaw doctor
```

If the Gateway is remote, ensure the tunnel/Tailscale connection is up and that the UI
is pointed at the right Gateway. [Remote access](/gateway/remote) を参照してください。

### オンボーディングをやり直すことなく、新しいマシン Mac miniにセットアップを移行できますか?

はい **state directory** と **workspace** をコピーして、Doctor を一度実行します。 この
は**両方**の場所をコピーする限り、あなたのボットが「正確に同じ」（メモリ、セッション履歴、auth、チャンネル
状態）を保持します。

1. 新しいマシンにOpenClawをインストールします。
2. 古いマシンから`$OPENCLAW_STATE_DIR`（デフォルト：`~/.openclaw`）をコピーします。
3. ワークスペースをコピーします (デフォルト: `~/.openclaw/workspace`)。
4. `openclawドクター`を実行し、ゲートウェイサービスを再起動します。

それは構成、認証プロファイル、WhatsAppのクレジット、セッション、およびメモリを保持します。
リモート・モードの場合は、ゲートウェイホストがセッション・ストアとワークスペースを所有していることを覚えておいてください。

**Important:** if you only commit/push your workspace to GitHub, you're backing
up **memory + bootstrap files**, but **not** session history or auth. `~/.openclaw/` の下にある
を生きます (例えば、 `~/.openclaw/agents/<agentId>/sessions/`)。

Related: [Migrating](/install/migrating), [Where things live on disk](/help/faq#where-does-openclaw-store-its-data),
[Agent workspace](/concepts/agent-workspace), [Doctor](/gateway/doctor),
[Remote mode](/gateway/remote).

### 最新バージョンの新機能はどこで確認できますか？

GitHub の変更履歴を確認してください:
[https://github.com/openclaw/openclaw/blob/main/CHANGELOG.md](https://github.com/openclaw/openclaw/blob/main/CHANGELOG.md)

最新のエントリが上部にあります。 上のセクションが**未リリース**とマークされている場合、次の日付の
セクションは最新の出荷バージョンです。 エントリは**ハイライト**、**変更**、および
**修正**（必要に応じてドキュメント/その他のセクション）でグループ化されます。

### [docs.openclaw.ai にアクセスできません（SSL エラー）。どうすればいいですか？](#i-cant-access-docsopenclawai-ssl-error-what-now)

Xfinity
Advanced Securityを介して `docs.openclaw.ai` をブロックするComcast/Xfinity 接続があります。 無効にするか、 `docs.openclaw.ai` を許可し、再試行してください。 More
detail: [Troubleshooting](/help/troubleshooting#docsopenclawai-shows-an-ssl-error-comcastxfinity).
Please help us unblock it by reporting here: [https://spa.xfinity.com/check_url_status](https://spa.xfinity.com/check_url_status).

それでもサイトにアクセスできない場合は、ドキュメントは GitHub でミラーリングされています:
[https://github.com/openclaw/openclaw/tree/main/docs](https://github.com/openclaw/openclaw/tree/main/docs)

### 安定版とベータ版の違いは？

**安定**と**ベータ**は**npm dist-tags**であり、別のコード行ではありません：

- `latest` = stable
- `beta` = テスト用の初期ビルド

We ship builds to **beta**, test them, and once a build is solid we **promote
that same version to `latest`**. だからベータ版と安定版は
**同じバージョン**を指すことができます。

変更内容:
[https://github.com/openclaw/openclaw/blob/main/CHANGELOG.md](https://github.com/openclaw/openclaw/blob/main/CHANGELOG.md)

### ベータ版と開発者の違いをインストールするにはどうすればいいですか？

**Beta** は npm dist-tag `beta` (`latest`と一致する可能性があります)。
**Dev** は `main` (git); の移動先頭です。公開されると、 npm dist-tag `dev` を使用します。

One-liners (macOS/Linux):

```bash
curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash -s -- --beta
```

```bash
curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash -s -- --install-method git
```

Windows installer (PowerShell):
[https://openclaw.ai/install.ps1](https://openclaw.ai/install.ps1)

詳細: [開発チャンネル](/install/development-channels) と [インストーラフラグ](/install/installer) 。

### インストールとオンボーディングには通常どのくらいかかりますか？

ラフガイド:

- **インストール:** 2-5分
- **オンボーディング:** 設定したチャンネル数/モデル数に応じて5-15 分

[「wake up my friend」で止まり、オンボーディングが起動しません。どうすればいいですか？](#it-is-stuck-on-wake-up-my-friend-onboarding-will-not-hatch-what-now)

### 最新のビットを試してみる方法

2つのオプション:

1. **開発チャンネル(git checkout):**

```bash
openclawアップデート --channel dev
```

`main` ブランチに切り替わり、ソースから更新します。

2. **ハッキング可能なインストール(インストーラーサイトから):**

```bash
curl -fsSL https://openclaw.ai/install.sh | bash -s -- --install-method git
```

これにより、git経由で編集し、更新できるローカルリポジトリが得られます。

クリーンなクローンを手動で使用する場合は、以下を使用してください。

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
pnpm install
pnpm build
```

Docs: [Update](/cli/update), [Development channels](/install/development-channels),
[Install](/install).

### [インストーラーが止まった場合、詳細なフィードバックを得るには？](#installer-stuck-how-do-i-get-more-feedback)

**冗長出力**でインストーラを再実行します:

```bash
curl -fsSL https://openclaw.ai/install.sh | bash -s -- --verbose
```

verboseを使ったベータ版のインストール:

```bash
curl -fsSL https://openclaw.ai/install.sh | bash -s --- -beta --verbose
```

hackable (git) インストールの場合:

```bash
curl -fsSL https://openclaw.ai/install.sh | bash -s ---install-method git ---verbose
```

その他のオプション: [Installer flags](/install/installer)。

### Windowsのインストールでは、git が見つからないか、openclawが認識されていないと表示されます

2つの一般的なWindowsの問題:

**1) npm error spawn git / git not found**

- **Git for Windows**をインストールし、`git`がPATH上にあることを確認してください。
- PowerShell を閉じて再起動し、インストーラを再実行します。

**2) openclawはインストール後に認識されません**

- npm global bin フォルダーが PATH にありません。

- パスを確認:

  ```powershell
  npm config get prefix
  ```

- `<prefix>\\bin`がPATH上にあることを確認します（ほとんどのシステムでは`%AppData%\\npm`）。

- PATHを更新した後、PowerShellを閉じて再び開きます。

Windowsをスムーズに設定したい場合は、ネイティブWindowsの代わりに**WSL2**を使用してください。
ドキュメント: [Windows](/platforms/windows).

### ドキュメントは、より良い答えを得るにはどうすればよい私の質問に答えませんでした。

Use the **hackable (git) install** so you have the full source and docs locally, then ask
your bot (or Claude/Codex) _from that folder_ so it can read the repo and answer precisely.

```bash
curl -fsSL https://openclaw.ai/install.sh | bash -s -- --install-method git
```

詳細: [Install](/install) と [Installer flags](/install/installer) 。

### OpenClawをLinuxにインストールする方法

簡単な答え:Linuxガイドに従って、オンボーディングウィザードを実行します。

- Linux quick path + service install: [Linux](/platforms/linux).
- Full walkthrough: [Getting Started](/start/getting-started).
- インストーラ+アップデート: [Install & updates](/install/updating).

### VPSにOpenClawをインストールする方法

どのLinux VPSでも動作します。 サーバーにインストールし、ゲートウェイに到達するためにSSH/Tailscaleを使用します。

ガイド: [exe.dev](/install/exe-dev), [Hetzner](/install/hetzner), [Fly.io](/install/fly).
リモートアクセス: [Gateway remote](/gateway/remote).

### cloudVPSのインストールガイド

一般的なプロバイダと**ホスティングハブ**を保持しています。 いずれかを選択してガイドに従ってください:

- [VPSホスティング](/vps) (すべてのプロバイダーが1つの場所にあります)
- [Fly.io](/install/fly)
- [Hetzner](/install/hetzner)
- [exe.dev](/install/exe-dev)

How it works in the cloud: the **Gateway runs on the server**, and you access it
from your laptop/phone via the Control UI (or Tailscale/SSH). あなたの状態 + ワークスペース
はサーバー上にあるので、ホストを真実の源泉として扱い、バックアップします。

**ノード**(Mac/iOS/Android/headless)をクラウドゲートウェイにペアリングすることで、
ローカルのスクリーン/カメラ/キャンバスにアクセスしたり、
ゲートウェイをクラウドに残しながらラップトップでコマンドを実行することができます。

ハブ: [Platforms](/platforms). リモートアクセス: [Gateway remote](/gateway/remote).
Nodes: [Nodes](/nodes), [Nodes CLI](/cli/nodes).

### OpenClawにアップデートを依頼することはできますか?

簡単な答え: **可能で、お勧めできません**。 更新フローは、
Gateway(アクティブなセッションをドロップする)を再起動することができ、クリーンなgit チェックアウトが必要な場合があり、
が確認を求めることができます。 より安全: オペレータとしてシェルから更新を実行します。

CLIを使用:

```bash
openclaw update
openclaw update status
openclaw update --channel stable|beta|dev
openclaw update --tag <dist-tag|version>
openclaw update --no-restart
```

エージェントから自動化する必要がある場合:

```bash
openclawの更新 --yes --no-restart
openclawゲートウェイ再起動
```

ドキュメント: [Update](/cli/update), [Updating](/install/updating).

### オンボーディングウィザードは実際に何をするのか

`openclawオンボード` が推奨されるセットアップパスです。 **ローカルモード** では以下のようにします。

- **Model/auth setup** (Anthropic **setup-token** for Claude subscriptions, OpenAI Codex OAuth supported, API keys optional, LM Studio local models)
- **ワークスペース** の場所 + ブートストラップファイル
- **ゲートウェイ設定** (bind/port/auth/tailscale)
- **プロバイダー** (WhatsApp, Telegram, Discord, Mattermost (plugin), Signal, iMessage)
- **デーモンインストール** (macOSでLaunchAgent; systemd user unit on Linux/WSL2)
- **健康チェック** と **スキル** 選択

また、構成されたモデルが不明な場合や、auth がない場合に警告します。

### これを実行するにはClaudeまたはOpenAIサブスクリプションが必要ですか？

いいえ. OpenClawは**APIキー** (Anthropic/OpenAI/others) または
**ローカル専用モデル** を使用してデバイスにデータを残すことができます。 サブスクリプション(Claude
Pro/MaxまたはOpenAI Codex)は、これらのプロバイダを認証するオプションの方法です。

Docs: [Anthropic](/providers/anthropic), [OpenAI](/providers/openai),
[ローカルモデル](/gateway/local-models), [Models](/concepts/models).

### API キーなしで Claude Max サブスクリプションを使用できますか?

はい API キーの代わりに **setup-token**
で認証できます。 これはサブスクリプションのパスです。

Claude Pro/Max サブスクリプション **API キーは含まれていません**ので、サブスクリプションアカウントの
正しいアプローチです。 重要: この使用がサブスクリプションポリシーおよび条件の下で許可されていることを、
Anthropicで確認する必要があります。
最も明示的でサポートされているパスが必要な場合は、Anthropic API キーを使用します。

### Anthropic setuptoken認証の仕組み

`claude setup-token` は、Claude Code CLI を介して **トークン文字列** を生成します (ウェブコンソールでは使用できません)。 **どのマシン**でも実行できます。 ウィザードで **Anthropic token (paste setup-token)** を選択するか、 `openclaw models auth paste-token ---provider anthropic` を貼り付けてください。 トークンは **anthropic** プロバイダの認証プロファイルとして保存され、API キー(自動更新なし)のように使用されます。 詳細: [OAuth](/concepts/oauth).

### Anthropic setuptokenはどこにありますか？

Anthropic Consoleでは**ない**です。 setup-tokenは**任意のマシン**の**Claude Code CLI**によって生成されます：

```bash
claude setup-token
```

出力されたトークンをコピーし、ウィザードで\*\*Anthropic token (paste setup-token)\*\*を選択します。 ゲートウェイホストで実行したい場合は、 `openclaw models auth-token --provider anthropic` を使用してください。 `claude setup-token`を他の場所で実行した場合は、`openclawモデルpaste-token ---provider anthropic`を使用してゲートウェイホストに貼り付けてください。 [Anthropic](/providers/anthropic) を参照してください。

### Claude サブスクリプション認証(Claude ProまたはMax)をサポートしていますか？

はい - **setup-token**を介して。 OpenClawはClaude Code CLI OAuthトークンを再利用しなくなりました。setup-tokenまたはAnthropic APIキーを使用します。 任意の場所にトークンを生成し、ゲートウェイホストに貼り付けます。 [Anthropic](/providers/anthropic) と [OAuth](/concepts/oauth) を参照してください。

注: Claude サブスクリプションへのアクセスは、Anthropic の規約に準拠します。 本番ワークロードまたはマルチユーザーワークロードの場合、API キーは通常より安全な選択です。

### Anthropic から HTTP 429 ratelimiterror が表示されるのはなぜですか？

つまり、**Anthropic quota/rate limit**は現在のウィンドウで使い果たされています。
**Claude サブスクリプション** (setup-token または Claude Code OAuth) を使用している場合は、ウィンドウが
リセットまたはアップグレードされるのを待ちます。 **Anthropic API キー**を使用する場合は、Anthropic Console
で使用/請求を確認し、必要に応じて制限を上げてください。

ヒント: **フォールバックモデル** を設定すると、プロバイダのレートが制限されている間もOpenClawが返信を続けることができます。
[Models](/cli/models) と [OAuth](/concepts/oauth) を参照してください。

### Is AWS Bedrock supported

はい - pi-ai の **Amazon Bedrock (Convers)** プロバイダを介して **手動設定** を使用します。 ゲートウェイホストにAWSの資格情報/リージョンを入力し、モデル設定にBedrockプロバイダエントリを追加する必要があります。 See [Amazon Bedrock](/providers/bedrock) and [Model providers](/providers/models). 管理されたキーフローを希望する場合は、Bedrockの前のOpenAI対応プロキシはまだ有効なオプションです。

### Codex authの仕組み

OpenClawはOAuth(ChatGPTサインイン)を介して\*\*OpenAIコード(Codex)\*\*をサポートしています。 ウィザードはOAuthフローを実行することができ、適切な場合にはデフォルトモデルを`openai-codex/gpt-5.3-codex`に設定します。 [Model providers](/concepts/model-providers) と [Wizard](/start/wizard) を参照してください。

### OpenAIサブスクリプション認証コードをサポートしていますか？

はい OpenClawは**OpenAIコード(Codex)サブスクリプションOAuth**を完全にサポートしています。 オンボーディング ウィザード
では、OAuth フローを実行できます。

[OAuth](/concepts/oauth), [Model providers](/concepts/model-providers), and [Wizard](/start/wizard) を参照してください。

### Gemini CLI OAuthの設定

ジェミニCLIは、`openclaw.json` のクライアントIDやシークレットではなく、**プラグインの認証フロー**を使用します。

操作方法:

1. プラグインを有効にする: `openclawプラグインを有効にするgoogle-gemini-cli-auth`
2. ログイン: `openclaw models auth login --provider google-gemini-cli --set-default`

これにより、OAuth トークンがゲートウェイホストの認証プロファイルに格納されます。 Details: [Model providers](/concepts/model-providers).

### ローカルモデルはカジュアルなチャットでOKです

通常はいいえ。 OpenClawは大きなコンテキストと強力な安全性を必要とします。小さなカードの切り捨てとリーク。 **最大** MiniMax M2.1ビルドを実行すると、ローカル(LM Studio)で[/gateway/local-models](/gateway/local-models) を見ることができます。 スモール/クオンタイズされたモデルはプロンプト注入のリスクを高めます - [Security](/gateway/security) を参照してください。

### 特定の地域でホストされているモデルトラフィックを維持するにはどうすればよいですか？

リージョン固定のエンドポイントを選択します。 OpenRouterは、MiniMax、Kimi、GLMのUSホストオプションを公開します。データをリージョン内に保持するには、米国がホストするバリアントを選択します。 \`models.mode: "merge"を使うことで、Anthropics/OpenAIをリストすることができます。そうすることで、選択したリージョン化されたプロバイダを尊重しながらフォールバックを利用できるようになります。

### これをインストールするにはMac Miniを購入する必要がありますか？

いいえ. OpenClawはmacOSまたはLinux(WSL2を介してWindows)で動作します。 Mac miniはオプションです。
常時オンホストとして購入する人もいます。 しかし、小さなVPS、ホームサーバー、またはラズベリーパイクラスのボックスも機能します。

Mac **MacOS専用のツール**のみ必要です。 iMessageの場合は、 [BlueBubbles](/channels/bluebubbles) を使用してください(推奨) - BlueBubblesサーバーはMac上で動作し、ゲートウェイはLinuxなどで動作します。 他のMacOS専用のツールが必要な場合は、GatewayをMac上で実行するか、macOSノードをペアリングしてください。

Docs: [BlueBubbles](/channels/bluebubbles), [Nodes](/nodes), [Mac remote mode](/platforms/mac/remote).

### iMessageサポートにはMacミニが必要ですか？

**macOS デバイス** がメッセージにサインインする必要があります。 It does **not** have to be a Mac mini -
any Mac works. **Use [BlueBubbles](/channels/bluebubbles)** (recommended) for iMessage - BlueBubblesサーバーはmacOS上で動作し、ゲートウェイはLinuxなどで動作します。

一般的な設定:

- Linux/VPS上でゲートウェイを実行し、メッセージにサインインしたMac上でBlueBubblesサーバーを実行します。
- 最も単一マシンのセットアップが必要な場合は、Mac上のすべてを実行します。

Docs: [BlueBubbles](/channels/bluebubbles), [Nodes](/nodes),
[Mac remote mode](/platforms/mac/remote).

### Mac miniを購入してOpenClawを実行すると、MacBook Proに接続できますか?

はい **Mac miniはゲートウェイ**を実行でき、MacBook Proは
**ノード**(コンパニオンデバイス)として接続できます。 Nodes don't run the Gateway - they provide extra
capabilities like screen/camera/canvas and `system.run` on that device.

共通パターン:

- Mac miniのゲートウェイ(常時オン)。
- MacBook Proは、macOSアプリまたはノードホストを実行し、Gatewayにペアを設定します。
- `openclaw nodes status` / `openclaw nodes list` を使用してください。

ドキュメント: [Nodes](/nodes), [Nodes CLI](/cli/nodes).

### Bun を使用できますか?

Bun は **推奨されません** 。 私たちは、特にWhatsAppとTelegramでランタイムのバグを見ます。
安定したゲートウェイには**ノード**を使用してください。

If you still want to experiment with Bun, do it on a non-production gateway
without WhatsApp/Telegram.

### 許可されているものをTelegram

`channels.telegram.allowFrom` は **人間の送信者のTelegram ユーザー ID** (数値、推奨) または `@username` です。 Botのユーザー名ではありません。

より安全（サードパーティなし）:

- ボットにDMを付けて、`openclawログ --follow` を実行し、`from.id` を読み込みます。

公式Bot API:

- ボットにDMをかけ、`https://api.telegram.org/bot<bot_token>/getUpdates` を呼び出し、`message.from.id` を読み込みます。

サードパーティ（プライバシー低）:

- DM `@userinfobot` または `@getidsbot` 。

[/channels/telegram](/channels/telegram#access-control-dms--groups)を参照してください。

### 複数の人が異なるOpenClawインスタンスで1つのWhatsApp番号を使用することができます。

はい、**マルチエージェントルーティング**を介して。 各送信者のWhatsApp **DM** (peer `kind: "dm"`, sender E. 64 は `+15551234567` のように異なる `agentId` になっているので、各人はそれぞれ独自のワークスペースとセッションストアを取得します。 返信はまだ**同じWhatsAppアカウント**から来ており、DMアクセス制御(`channels.whatsapp.dmPolicy` / `channels.whatsapp.allowFrom`)はWhatsAppアカウントごとにグローバルです。 [マルチエージェントルーティング](/concepts/multi-agent) と [WhatsApp](/channels/whatsapp) を参照してください。

### 高速チャットエージェントとコーディングエージェントの Opus を実行できますか?

はい マルチエージェントルーティングを使用する:各エージェントに独自のデフォルトモデルを与え、各エージェントにインバウンドルート(プロバイダアカウントまたは特定のピア)をバインドします。 設定例は [マルチエージェントルーティング](/concepts/multi-agent) にあります。 [Models](/concepts/models) と [Configuration](/gateway/configuration) も参照してください。

### HomebrewはLinuxで動作しますか？

はい Homebrew は Linux (Linuxbrew) をサポートしています。 クイックスタート:

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
echo 'eval "$(/home/linuxbrew/.linuxbrew/bin/brew shellenv)"" >> ~/.profile
eval "$(/home/linuxbrew/.linuxbrew/bin/brew shellenv)"
brew install <formula>
```

OpenClaw を systemd 経由で実行する場合は、PATH には `/home/linuxbrew/.linuxbrew/bin` (または、brew prefix) が含まれていることを確認してください。これにより、`brew`-installed ツールは非ログインシェルで解決されます。
最近のビルドでは、Linux systemd サービスの一般的なユーザ bin dirsが先頭に追加されます (例えば、 `~/.local/bin`、`~/.npm-global/bin`、`~/.local/share/pnpm`、`~/)。 un/bin`) そして `PNPM_HOME` 、 `NPM_CONFIG_PREFIX` 、 `BUN_INSTALLL`、 `VOLTA_HOME`、 `ASDATA_DIR`、 `NVM_DIR`、 `FNM_DIR`を設定します。

### Hackable git install と npm install の違いは何ですか？

- **Hackable (git) install:** full source checkout, editable, best for contributors.
  ローカルでビルドを実行し、コード/ドキュメントにパッチを適用できます。
- **npm install:** global CLI install, no repo, best for "just run it".
  npm dist-tagsから更新が来ます。

Docs: [Getting started](/start/getting-started), [Updating](/install/updating).

### npm と git のインストールを後で切り替えることはできますか?

はい 他のフレーバーをインストールし、新しいエントリポイントにゲートウェイのサービスポイントを表示するように Doctor を実行します。
この**データは削除されません** - OpenClawコードのインストールだけを変更します。 あなたの状態
(`~/.openclaw`) とワークスペース (`~/.openclaw/workspace`) はそのまま残ります。

npm から → git:

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
pnpm install
pnpm build
openclaw doctor
openclaw gateway restart
```

git → npmから:

```bash
npm install -g openclaw@latest
openclaw doctor
openclaw gateway restart
```

Doctor はゲートウェイサービスのエントリポイントの不一致を検出し、現在のインストールに一致するようにサービス設定を書き換えることを提供します (自動化で `--repair` を使用します)。

Backup tips: see [Backup strategy](/help/faq#whats-the-recommended-backup-strategy).

### ラップトップまたはVPSでゲートウェイを実行する必要があります。

簡単な答え: **24時間年中無休の信頼性が欲しい場合は、VPS**を使用してください。
摩擦が最も低く、スリープ/再起動でも大丈夫なら、ローカルに実行してください。

**ラップトップ（ローカルゲートウェイ）**

- **Pros:** サーバーコストはなく、ローカルファイル、ライブブラウザウィンドウに直接アクセスできます。
- **短所:** sleep/network drops = disconnects, OS の更新/再起動の中断, スリープ状態を維持する必要があります。

**VPS/クラウド**

- **Pros:** 常にオン、安定したネットワークで、ラップトップの睡眠の問題はありません。簡単に実行できます。
- **Cons:** よくヘッドレスで（スクリーンショットを使用）リモートファイルアクセスのみを実行します。SSHで更新する必要があります。

**OpenClaw固有の注意事項:** WhatsApp/Telegram/Slack/Mattermost (plugin)/DiscordはすべてVPSからうまく動作します。 実際のトレードオフは、**ヘッドレスブラウザー** と 表示されるウィンドウのみです。 [Browser](/tools/browser) を参照してください。

**推奨されるデフォルト:** 以前にゲートウェイが切断していた場合VPS。 ローカルは、Macを積極的に使用していて、ブラウザでローカルファイルへのアクセスやUIオートメーションを望むときに最適です。

### OpenClawを専用のマシンで実行することがどれほど重要か

必須ではありませんが、**信頼性と分離を推奨します**。

- **専用ホスト (VPS/Mac mini/Pi):** 常時オン、スリープ/再起動の中断の少ない、クリーンなパーミッション、実行し続けるのが簡単。
- **共有されたラップトップ/デスクトップ：** テストやアクティブな使用には問題ありませんが、マシンがスリープやアップデートを行うと一時停止することを期待しています。

両方の世界のベストをご希望の場合は Gatewayを専用ホストに保ち、ローカルのスクリーン/カメラ/exec ツールの **ノード** としてラップトップをペアリングします。 [Nodes](/nodes) を参照してください。
セキュリティガイダンスについては、 [Security](/gateway/security) を参照してください。

### 最小VPS要件と推奨OS

OpenClawは軽量です。 ゲートウェイ+基本的なチャットチャンネル:

- **Absolute minimum:** 1 vCPU, 1GB RAM, ~500MB ディスク.
- **推奨：** 1-2 vCPU、2GB RAM以上のヘッドルーム（ログ、メディア、複数のチャンネル）。 ノードツールとブラウザーの自動化は、リソースに飢えている可能性があります。

OS: **Ubuntu LTS** (または最新のDebian/Ubuntu) を使用してください。 Linuxのインストールパスは、そこで最もテストされています。

Docs: [Linux](/platforms/linux), [VPSホスティング](/vps).

### OpenClawをVMで実行することはできますか?

はい VPSと同じVMを扱う:常にオン、到達可能である必要があります。 そしてゲートウェイと有効な任意のチャンネルに
RAMが十分にあります。

ベースラインのガイダンス:

- **絶対最小限:** 1 vCPU, 1GB RAM.
- **推奨:** 複数のチャンネル、ブラウザの自動化、またはメディアツールを実行している場合は、2GB RAM以上。
- **OS:** Ubuntu LTSまたは他のモダンなDebian/Ubuntu.

Windowsの場合、**WSL2は最も簡単なVMスタイルのセットアップ**で、最高のツール
互換性があります。 [Windows](/platforms/windows), [VPSホスティング](/vps)を参照してください。
VM で macOS を実行している場合は、[macOS VM](/install/macos-vm)を参照してください。

## What is OpenClaw?

### 1つの段落のOpenClawとは

OpenClawはあなた自身のデバイス上で実行する個人的なAIアシスタントです。 すでに使用しているメッセージングサーフェス(WhatsApp、Telegram、Slack、Mattermost(プラグイン)、Discord)に応答します。 Googleチャット、Signal、iMessage、WebChat)およびサポートされているプラットフォームで音声+ライブキャンバスを行うこともできます。 **Gateway** は常時オン制御盤です。アシスタントは製品です。

### 価値提案の内容

OpenClawは「単なるクロードのラッパー」ではありません。 It's a **local-first control plane** that lets you run a
capable assistant on **your own hardware**, reachable from the chat apps you already use, with
stateful sessions, memory, and tools - without handing control of your workflows to a hosted
SaaS.

ハイライト:

- **お使いのデバイス、データ:** ご希望の場所(Mac、Linux、VPS)でゲートウェイを実行し、
  ワークスペース + セッション履歴をローカルに保持します。
- **実際のチャンネル、ウェブサンドボックスではありません:** WhatsApp/Telegram/Slack/Discord/Signal/iMessage/etc、
  プラスモバイル音声とCanvas 対応プラットフォーム。
- **Model-agnostic:** Anthropic, OpenAI, MiniMax, OpenRouterなどをエージェントごとのルーティング
  とフェイルオーバーで使用します。
- **ローカルのみのオプション:** ローカルモデルを実行すると、**すべてのデータがあなたのデバイスに残る** ことができます。
- **マルチエージェントのルーティング:** チャンネル、アカウント、またはタスクごとに、それぞれ独自の
  ワークスペースとデフォルトを持つエージェントを分けます。
- **オープンソースとハッキング可能:** ベンダーロックインなしで、検査、拡張、およびセルフホストを行います。

Docs: [Gateway](/gateway), [Channels](/channels), [Multi-agent](/concepts/multi-agent),
[Memory](/concepts/memory).

### 最初に何をすべきかを設定しました

良い最初のプロジェクト:

- ウェブサイト(WordPress、Shopify、またはシンプルな静的サイト)を構築します。
- モバイルアプリ(概要、画面、APIプラン)をプロトタイプ化します。
- ファイルとフォルダを整理します(クリーンアップ、名前付け、タグ付け)。
- Gmailを接続し、概要やフォローアップを自動化します。

大きなタスクを処理することができますが、それらをフェーズに分割し、
はサブエージェントを並列作業に使用する場合に最適です。

### OpenClawの毎日のトップ5のユースケースは何ですか？

毎日の勝利は通常次のようになります：

- **パーソナルブリーフィング:** 受信トレイ、カレンダー、あなたが気になるニュースの概要。
- **研究と製図:** メールやドキュメントの簡単なリサーチ、概要、および最初のドラフト。
- **リマインダーとフォローアップ：** cronまたはheartbeat駆動のnudgesとチェックリスト。
- **ブラウザの自動化:** フォームを入力し、データを収集し、Webタスクを繰り返します。
- **クロスデバイスの座標** スマートフォンからタスクを送信し、ゲートウェイにサーバー上でタスクを実行させ、結果をチャットに戻します。

### OpenClawはSaaSのリード世代の広告やブログを支援できますか？

**研究、資格、ドラフト**についてはあります。 It can scan sites, build shortlists,
summarize prospects, and write outreach or ad copy drafts.

**アウトリーチや広告実行**の場合は、人間をループさせてください。 スパムを避け、現地の法律および
プラットフォームポリシーに従い、送信前に何でも確認してください。 最も安全なパターンは、
OpenClawドラフトを許可して承認することです。

ドキュメント: [Security](/gateway/security).

### Web開発のためのクロードコードとの利点は何ですか

OpenClawは**パーソナルアシスタント**であり、IDEの置き換えではありません。
クロードコードまたはコーデックスを使用して、リポジトリ内で最速のダイレクトコーディングループを作成します。 Use OpenClaw when you
want durable memory, cross-device access, and tool orchestration.

利点:

- セッションごとに**永続的なメモリ + ワークスペース**
- **マルチプラットフォームアクセス** (WhatsApp, Telegram, TUI, WebChat)
- **ツールオーケストレーション** (ブラウザ、ファイル、スケジュール、フック)
- **常時オンゲートウェイ** (VPS上で動作し、どこからでも動作します)
- **Nodes** ローカルブラウザ/スクリーン/カメラ/exec

ショーケース: [https://openclaw.ai/showcase](https://openclaw.ai/showshowse)

## スキルと自動化

### レポを汚さずにスキルをカスタマイズする方法

リポジトリコピーを編集する代わりに、管理されたオーバーライドを使用します。 `~/.openclaw/skills/<name>/SKILL.md` （`~/.openclaw/openclaw.json`の`skills.load.extraDirs`経由でフォルダを追加） Precedence is `<workspace>/skills` > `~/.openclaw/skills` > バンドルされているため、gitに触れることなく管理されたオーバーライドが勝利します。 上流にふさわしい編集のみがレポに住み、PRとして出てください。

### カスタムフォルダからスキルを読み込むことはできますか？

はい `~/.openclaw/openclaw.json` の中に`skills.load.extraDirs`を使って追加のディレクトリを追加します（最も低い優先順位）。 デフォルトの優先順位は残ります: `<workspace>/skills` → `~/.openclaw/skills` → バンドル → `skills.load.extraDirs` 。 `clawhub`はデフォルトで`./skills`にインストールされ、OpenClawは`<workspace>/skills`として扱います。

### 異なるタスクに異なるモデルを使用する方法

現在サポートされているパターンは次のとおりです。

- **Cron jobs**: ジョブごとに「モデル」オーバーライドを設定できます。
- **サブエージェント**: 異なるデフォルトモデルを持つ別のエージェントにタスクをルーティングします。
- **オンデマンドスイッチ**: `/model` を使用して、いつでも現在のセッションモデルを切り替えます。

[Cron jobs](/automation/cron-jobs), [Multi-Agent Routing](/concepts/multi-agent), and [Slash commands](/tools/slash-commands) を参照してください。

### 作業中にボットがフリーズします。どうすればオフロードできますか？

**サブエージェント** を使用して、長いタスクや並列タスクを実行します。 サブエージェントは、独自のセッションで実行されます。
はサマリーを返し、メインチャットを反映させ続けます。

ボットに「このタスクにサブエージェントを生成する」ように依頼するか、`/subagents` を使用してください。
チャットで `/status` を使用して、ゲートウェイが今何をしているかを確認しましょう（そして忙しいのかを確認します）。

トークンのヒント:長いタスクとサブエージェントの両方がトークンを消費します。 コストが懸念される場合は、`agents.defaults.subagents.model` を使用してサブエージェントの
安価なモデルを設定します。

ドキュメント: [Sub-agents](/tools/subagents).

### Cronまたはリマインダーを起動しない

Cronはゲートウェイプロセス内で動作します。 ゲートウェイが継続的に実行されていない場合、
スケジュールされたジョブは実行されません。

チェックリスト:

- Confirm cron is enabled (`cron.enabled`) and `OPENCLAW_SKIP_CRON` is not set
- ゲートウェイが24時間365日稼働していることを確認してください(睡眠/再起動なし)。
- ジョブのタイムゾーン設定を確認します (`--tz` vs ホストのタイムゾーン)。

Debug:

```bash
openclaw cron run <jobId> --force
openclaw cron run --id <jobId> --limit 50
```

Docs: [Cron jobs](/automation/cron-jobs), [Cron vs Heartbeat](/automation/cron-vs-heartbeat).

### Linuxにスキルをインストールする方法

**ClawHub** (CLI) を使用するか、ワークスペースにスキルをドロップします。 Linux では、macOS Skills UI は利用できません。
[https://clawhub.com](https://clawhub.com)でスキルを参照してください。

ClawHub CLI をインストールします(パッケージマネージャを1つ選択します):

```bash
npm i -g clawhub
```

```bash
pnpm add -g clawhub
```

### OpenClawはスケジュールまたはバックグラウンドで連続的にタスクを実行できます。

はい ゲートウェイスケジューラを使用:

- スケジュールされたタスクまたは繰り返されるタスクの**Cronジョブ** (再起動後も継続します)。
- **Heartbeat** は「メインセッション」の定期的なチェックを行います。
- サマリーを投稿したりチャットに配信したりする自律エージェントの **単離されたジョブ**

Docs: [Cron jobs](/automation/cron-jobs), [Cron vs Heartbeat](/automation/cron-vs-heartbeat),
[Heartbeat](/gateway/heartbeat).

### Apple macOSのみのスキルをLinuxから実行できますか?

直接ではありません macOS のスキルは `metadata.openclaw.os` に加えて必要なバイナリによって与えられ、スキルは **Gateway ホスト** の対象となっている場合にのみシステムプロンプトに表示されます。 Linuxでは、`darwin`のみのスキル（`apple-notes`、`apple-reminders`、`things-mac`など）は、gatingをオーバーライドしない限りロードされません。

3つのパターンがサポートされています:

\*\*Option A - Mac でゲートウェイを走らせる（簡単）。 \*
macOS バイナリが存在するゲートウェイを実行し、[remode](#how-do-i-run-openclaw-in-remote-mode-client-connects-to-a-gateway-elsewhere) または Tailscale 上で Linux から接続します。 ゲートウェイホストがmacOSであるため、通常はスキルがロードされます。

\*\*Option B - macOSノード(SSHなし)を使用します。 \*
Linux 上でゲートウェイを実行し、macOS ノード (menubar app) をペアリングします。 そして **Node Run Commands** を Mac で「Always Ask」または「Always Allow」に設定します。 OpenClawは必要なバイナリがノード上に存在する場合、macOSのみのスキルを対象として扱うことができます。 エージェントは `nodes` ツールを使ってこれらのスキルを実行します。 「Always Ask」を選択した場合、プロンプトで「Always Allow」を承認すると、そのコマンドが許可リストに追加されます。

\*\*Option C - SSH (advanced) を介してプロキシmacOSバイナリ。 \*
GatewayをLinux上に保ちますが、必要なCLIバイナリをMac上で実行するSSHラッパーに変更します。 次に、Linux が有効なままになるようにスキルを上書きします。

1. バイナリの SSH ラッパーを作成します (例: Apple Notes の `memo` )。

   ```bash
   #!/usr/bin/env bash
   set -euo pipefail
   exec ssh -T user@mac-host /opt/homebrew/bin/memo "$@"
   ```

2. `PATH`のラッパーをLinuxホストに置きます（例えば`~/bin/memo`）。

3. Linuxを許可するには、スキルメタデータ (ワークスペースまたは `~/.openclaw/skills`) を上書きします。

   ```markdown
   ---
   name: apple-notes
   description: Manage Apple Notes via the memo CLI on macOS.
   metadata: { "openclaw": { "os": ["darwin", "linux"], "requires": { "bins": ["memo"] } } }
   ---
   ```

4. スキルスナップショットが更新されるように、新しいセッションを開始します。

### NotionまたはHeyGen統合をお持ちですか？

今日は組み込みではありません。

選択肢：

- **カスタムスキル/プラグイン:** 信頼性の高い API アクセスに最適です (注意/HeyGen 両方に API があります)。
- **ブラウザの自動化**はコードなしで動作しますが、より遅く壊れやすいです。

クライアントごとのコンテキスト(エージェンシーワークフロー)を維持したい場合、シンプルなパターンは次のとおりです。

- クライアントごとに1つの通知ページ (コンテキスト + 環境設定 + アクティブな作業)。
- エージェントにセッションの開始時にそのページを取得するように依頼します。

If you want a native integration, open a feature request or build a skill
targeting those APIs.

スキルをインストール:

```bash
clawhubのインストール <skill-slug>
clawhubの更新 --all
```

ClawHub は ` にインストールされます。 現在のディレクトリの下にある「スキル」（または設定済みのOpenClawワークスペースに戻る）。OpenClawは次のセッションで「<workspace>/skills」として扱います。 エージェント間でスキルを共有するには、`~/.openclaw/skills/<name>/SKILL.md\` に配置します。 いくつかのスキルはHomebrewを介してバイナリをインストールすることを期待しています。LinuxではLinuxbrewを意味します(上記のHomebrew Linux FAQエントリを参照してください)。 [Skills](/tools/skills) と [ClawHub](/tools/clawhub) を参照してください。

### ブラウザの乗っ取りにChrome拡張機能をインストールする方法

内蔵のインストーラを使用して、Chrome で展開された拡張機能をロードします。

```bash
openclaw browser extension install
openclaw browser extension path
```

その後、Chrome → `chrome://extensions` → "開発者モード" → "解凍済みのロード" → そのフォルダを選択します。

完全ガイド(リモートゲートウェイ+セキュリティノートを含む): [Chrome extension](/tools/chrome-extension)

GatewayがChromeと同じマシン(デフォルト設定)で動作している場合、**余分なものは必要ありません**。
Gateway が別の場所で実行されている場合は、ブラウザーマシンで node host を実行し、
Gateway がブラウザー操作をプロキシできるようにしてください。
あなたが制御したいタブで拡張機能ボタンをクリックする必要があります(それは自動添付されません)。

## サンドボックス化とメモリ

### サンドボックス作成専用のドキュメントがありますか？

はい [Sandboxing](/gateway/sandboxing) を参照してください。 Docker固有のセットアップ (DockerまたはSandboxイメージの完全なゲートウェイ) については、 [Docker](/install/docker) を参照してください。

### Dockerの気分は限られています フル機能を有効にするにはどうすればいいですか?

The default image is security-first and runs as the `node` user, so it does not
include system packages, Homebrew, or bundled browsers. フルセットアップの場合:

- `OPENCLAW_HOME_VOLUME` で `/home/node` を保持し、キャッシュは生き残ります。
- `OPENCLAW_DOCKER_APT_PACKAGES` を使用してシステムデップを画像に焼きます。
- バンドルされた CLI 経由で Playwrite ブラウザーをインストールします:
  `node /app/node_modules/playwright-core/cli.js install chromium`
- `PLAYWRIGHT_BROWSERS_PATH` を設定し、パスが保持されていることを確認します。

ドキュメント: [Docker](/install/docker), [Browser](/tools/browser).

**DMを個人的なままにしておくことはできますが、グループを1つのエージェントでサンドボックス化することはできます**

はい - プライベートトラフィックが **DMs** で、パブリックトラフィックが **グループ** である場合。

`agents.defaults.sandbox.mode: "non-main"` を使用すると、グループ/チャンネルセッション (メインキー以外) が Docker で実行され、メインの DM セッションはホスト上にとどまります。 `tools.sandbox.tools` を使用してサンドボックス化されたセッションで利用できるツールを制限します。

設定ウォークスルー+設定例: [Groups: personal DM + public groups](/channels/groups#pattern-personal-dms-public-groups-single-agent)

キー設定参照: [ゲートウェイ設定](/gateway/configuration#agentsdefaultssandbox)

### ホストフォルダを Sandbox にバインドする方法

`agents.defaults.sandbox.docker.binds` に `["host:path:mode"]` (例: `"/home/user/src:/src:ro"`)を設定します。 グローバル+エージェントごとの結合はマージします。`scope: "shared"` の場合、エージェントごとの結合は無視されます。 sandbox ファイルシステムの壁を避けるためには、 `:ro` を使ってください。 例や安全メモについては、 [Sandboxing](/gateway/sandboxing#custom-bind-mounts) と [Sandbox vs Tool Policy vs Elevated](/gateway/sandbox-vs-tool-policy-vs-elevated#bind-mounts-security-quick-check)を参照してください。

### メモリの仕組みを教えてください

OpenClawメモリは、エージェントワークスペースのMarkdownファイルにすぎません。

- 毎日のノート (memory/YYYY-MM-DD.md)
- `MEMORY.md` でキュレートされた長期ノート (メイン/プライベートセッションのみ)

OpenClaw also runs a **silent pre-compaction memory flush** to remind the model
to write durable notes before auto-compaction. これはワークスペース
が書き込み可能(読み取り専用の Sandbox がスキップしている場合にのみ実行されます)。 [Memory](/concepts/memory) を参照してください。

### 物事を忘れてしまい続けるメモリ どのように棒状にするか

Botに**メモリに事実を書き込む**ように頼みます。 長期間のノートは `MEMORY.md` に属します。
短期間のコンテキストは `memory/YYYY-MM-DD.md` になります。

これはまだ私たちが改善している領域です。 思い出を保存するためにモデルに思い出させるのに役立ちます。
それは何をすべきかを知ることになります。 忘れ続ける場合は、ゲートウェイが毎回同じ
ワークスペースを使用していることを確認してください。

Docs: [Memory](/concepts/memory), [Agent workspace](/concepts/agent-workspace).

### セマンティックメモリ検索にはOpenAI APIキーが必要ですか？

**OpenAI埋め込み**を使用している場合にのみ。 Codex OAuth covers chat/completions and
does **not** grant embeddings access, so **signing in with Codex (OAuth or the
Codex CLI login)** does not help for semantic memory search. OpenAI 埋め込み
には実際の API キー (`OPENAI_API_KEY` または `models.providers.openai.apiKey` ) が必要です。

If you don't set a provider explicitly, OpenClaw auto-selects a provider when it
can resolve an API key (auth profiles, `models.providers.*.apiKey`, or env vars).
OpenAIキーが解決した場合はOpenAIを好み、ジェミニキー
が解決した場合はGeminiを好みます。 どちらのキーも使用できない場合、
設定するまでメモリ検索は無効になります。 ローカルモデルパスを設定して存在する場合、OpenClaw
は `local` を優先します。

ローカルのままにしたい場合は、 `memorySearch.provider = "local"` (オプションで
`memorySearch.fallback = "none"`)を設定してください。 Geminiの埋め込みが必要な場合は、
`memorySearch.provider = "gemini"`を設定し、`GEMINI_API_KEY` (または
`memorySearch.remote.apikey`)を提供します。 We support **OpenAI, Gemini, or local** embedding
models - see [Memory](/concepts/memory) for the setup details.

### メモリが永続的に保持されますか?

メモリファイルはディスク上に保存され、削除するまで保存されます。 制限はモデルではなくあなたの
ストレージです。 **セッション コンテキスト** はモデル
コンテキストウィンドウによってまだ制限されているため、長い会話がコンパクトになったり切り詰められたりすることがあります。 そのため、
メモリ検索が存在し、関連する部品のみをコンテキストに戻します。

ドキュメント: [Memory](/concepts/memory), [Context](/concepts/context).

## 物事がディスク上にある場所

### ローカルに保存されたOpenClawで使用されるすべてのデータです

いいえ - **OpenClawの状態はローカル**ですが、**外部サービスは送信内容を確認**しています。

- **Local by default:** sessions, memory files, config, and workspace live on the Gateway host
  (`~/.openclaw` + your workspace directory).
- **必要に応じてリモート:** モデルプロバイダ（Anthropic/OpenAI/etc）に送信するメッセージ。 go to
  their APIs, and chat platforms (WhatsApp/Telegram/Slack/etc.)
  サーバーにメッセージデータを保存します。
- **あなたは足跡を制御します:** ローカルモデルを使用してあなたのマシンのプロンプトを保持しますが、チャンネル
  のトラフィックはまだチャネルのサーバーを通過します。

関連: [Agent workspace](/concepts/agent-workspace), [Memory](/concepts/memory).

### OpenClawはどこでデータを保存しますか？

すべてが`$OPENCLAW_STATE_DIR`の下にあります（デフォルト：`~/.openclaw`）：

| パス                                                              | 目的                                                       |
| --------------------------------------------------------------- | -------------------------------------------------------- |
| `$OPENCLAW_STATE_DIR/openclaw.json`                             | メイン設定 (JSON5)                         |
| `$OPENCLAW_STATE_DIR/credentials/oauth.json`                    | 従来の OAuth インポート (最初の使用時に認証プロファイルにコピー) |
| `$OPENCLAW_STATE_DIR/agents/<agentId>/agent/auth-profiles.json` | 認証プロファイル (OAuth + API キー)             |
| `$OPENCLAW_STATE_DIR/agents/<agentId>/agent/auth.json`          | ランタイム認証キャッシュ (自動的に管理)                 |
| `$OPENCLAW_STATE_DIR/credentials/`                              | プロバイダの状態（例：`whatsapp/<accountId>/creds.json`）            |
| `$OPENCLAW_STATE_DIR/agents/`                                   | エージェント毎の状態 (agentDir + セッション)         |
| `$OPENCLAW_STATE_DIR/agents/<agentId>/sessions/`                | 会話の履歴と状態（エージェントごと）                                       |
| `$OPENCLAW_STATE_DIR/agents/<agentId>/sessions/sessions.json`   | セッションメタデータ（エージェントごと）                                     |

従来のシングルエージェントパス: `~/.openclaw/agent/*` (`openclaw医師`によって移行されました)。

**ワークスペース** (AGENTS.md, メモリファイル, スキルなど) は、`agents.defaults.workspace` を介して別々に設定されています（デフォルト：`~/.openclaw/workspace`）。

### AGENTSmd SOULmd USERmd MEMORYmd はどこに住むべきか

これらのファイルは、 `~/.openclaw` ではなく、 **agent workspace** に含まれています。

- **ワークスペース (エージェントごと)**: `AGENTS.md`, `SOUL.md`, `IDENTITY.md`, `USER.md`,
  `MEMOORY.md` (または `memory.md`), `memory/YYYY-MM-DD.md`, オプションの `HEARTBEAT.md`.
- **State dir (`~/.openclaw`)**: config, credentials, auth profiles, sessions, logs,
  and shared skills (`~/.openclaw/skills`).

デフォルトのワークスペースは `~/.openclaw/workspace` で設定できます。

```json5
{
  agents: { defaults: { workspace: "~/.openclaw/workspace" } },
}
```

Botが再起動後に「忘れる」場合 ゲートウェイが起動するたびに同じ
ワークスペースを使用していることを確認します (リモートモードでは **ゲートウェイホスト**
ワークスペースを使用します)。 地元のラップトップではない

ヒント：耐久性のある動作や好みが欲しい場合は、ボットに\*\*
エージェントに書き込むように依頼してください。 チャット履歴に依存するのではなく、dまたはMEMORY.md\*\*。

[Agent workspace](/concepts/agent-workspace) と [Memory](/concepts/memory) を参照してください。

### 推奨されるバックアップ戦略

Put your **agent workspace** in a **private** git repo and back it up somewhere
private (for example GitHub private). これはメモリ+AGENTS/SOUL/USER
ファイルをキャプチャし、アシスタントの「心」を後で復元することができます。

`~/.openclaw`（資格情報、セッション、トークン）の下でコミットしないでください。
完全な復元が必要な場合は、ワークスペースとステートディレクトリ
を個別にバックアップしてください(上記の移行問題を参照)。

Docs: [Agent workspace](/concepts/agent-workspace).

### OpenClawを完全にアンインストールする方法

専用ガイド: [Uninstall](/install/uninstall) を参照してください。

### エージェントはワークスペースの外で作業できますか？

はい ワークスペースは **デフォルト cwd** とメモリ アンカーであり、ハード サンドボックスではありません。
ワークスペース内では相対パスは解決されますが、サンドボックス化が有効になっていない限り、絶対パスは他の
ホストにアクセスできます。 分離が必要な場合は、
[`agents.defaults.sandbox`](/gateway/sandboxing) または sandbox ごとの設定を使用します。
リポジトリをデフォルトの作業ディレクトリにしたい場合は、エージェントの
`workspace` をリポジトリのルートに指定します。 OpenClaw リポジトリはソースコードに過ぎません。エージェントが意図的に内部で動作させる場合を除き、
ワークスペースは別々にしておいてください。

例 (デフォルトcwdとしてリポジトリ):

```json5
{
  agents: {
    defaults: {
      workspace: "~/Projects/my-repo",
    },
  },
}
```

### Im in remote mode where the session store

セッション状態は **ゲートウェイホスト** が所有しています。 リモートモードの場合、セッションストアはローカルのラップトップではなく、リモートマシン上にあります。 1. [セッション管理](/concepts/session)を参照してください。

## 設定の基本

### 設定のフォーマットはどこにありますか？

OpenClawはオプションの**JSON5**設定を$OPENCLAW_CONFIG_PATH`から読み込みます（デフォルト：`~/.openclaw/openclaw.json\`）。

```
$OPENCLAW_CONFIG_PATH
```

ファイルが見つからない場合は、セーフなデフォルト値を使用します (`~/.openclaw/workspace`のデフォルトワークスペースを含みます)。

### gatewaybindlanまたはtailnetを設定しました。今はUIが不正であることを聞くものはありません。

Non-loopback binds **require auth**. `gateway.auth.mode` + `gateway.auth.token` を設定します (または `OPENCLAW_GATEWAY_TOKEN` を使用します)。

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

配列は置換

- `gateway.remote.token` は **remote CLI calls** のみで、ローカルゲートウェイ認証を有効にしません。
- Control UI は `connect.params.auth.token` (app/UI 設定に保存されています) を介して認証します。 URLにトークンを入れないようにします。

### なぜ今すぐlocalhostにトークンが必要なのですか？

ウィザードはデフォルトで(ループバック時でも)ゲートウェイトークンを生成するため、**ローカル WS クライアントは認証**が必要です。 これにより、他のローカルプロセスがゲートウェイを呼び出すことをブロックします。 トークンを Control UI 設定 (またはクライアントの設定) に貼り付けて接続します。

**本当に** ループバックを開きたい場合は、設定から `gateway.auth` を削除してください。 医師はいつでもトークンを生成できます: `openclaw医師 --generate-gateway-token` 。

### 設定を変更した後に再起動する必要がありますか？

ゲートウェイは設定を監視し、ホットリロードをサポートします。

- `gateway.reload.mode: "hybrid"` (デフォルト): ホット適用される安全な変更、重要なもののために再起動します。
- `hot` 、 `restart` 、 `off` もサポートされています

### Web検索とWebフェッチを有効にする方法

`web_fetch` はAPIキーなしで動作します。 `web_search` にはBrave Search API
キーが必要です。 **推奨:** `openclaw configure --section web` を実行して、
`tools.web.search.apiKey` に保存します。 環境代替:
ゲートウェイプロセスに `BRAVE_API_KEY` を設定します。

```json5
2. {
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

配列は置換

- allowlistsを使用する場合は、 `web_search`/`web_fetch` または `group:web` を追加します。
- `web_fetch` は、明示的に無効化されない限りデフォルトで有効です。
- デーモンは `~/.openclaw/.env` (またはサービス環境) から env vars を読み込みます。

Docs: [Web tools](/tools/web).

### デバイス間で専門的なワーカーを使用して中央ゲートウェイを実行する方法

一般的なパターンは**1つのゲートウェイ**（例：ラズベリーパイ）と**ノード**と**エージェント**です。

- **Gateway (central):** チャンネル(Signal/WhatsApp)、ルーティング、セッションを所有しています。
- **ノード (デバイス):** Macs/iOS/Androidは周辺機器として接続し、ローカルツール (`system.run`, `canvas`, `camera`) を公開します。
- **エージェント（ワーカー）：** 特別な役割のための脳/ワークスペース（例：「Hetzner ops」、「個人データ」）。
- **サブエージェント:** 並列化したいときにメインエージェントからバックグラウンドワークを生成します。
- **TUI:** ゲートウェイに接続し、エージェント/セッションを切り替えます。

Docs: [Nodes](/nodes), [リモートアクセス](/gateway/remote), [マルチエージェントルーティング](/concepts/multi-agent), [Sub-agents](/tools/subagents), [TUI](/web/tui).

### OpenClawブラウザはヘッドレスで実行できますか？

はい 設定オプション:

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

デフォルトは `false` (headful) です。 ヘッドレスは、一部のサイトでアンチボットチェックを引き起こす可能性が高くなります。 [Browser](/tools/browser) を参照してください。

Headless は **同じ Chromium エンジン** を使用し、ほとんどのオートメーション（フォーム、クリック、スクラップ、ログイン）で動作します。 主な違い:

- ブラウザウィンドウが表示されません(画面が必要な場合はスクリーンショットを使用してください)。
- 一部のサイトでは、ヘッドレスモード(CAPTCHA、アンチボット)での自動化についてより厳しいものがあります。
  たとえば、X/Twitterはヘッドレスセッションをブロックすることがよくあります。

### ブラウザーコントロールにBraveを使用する方法

`browser.executablePath`をBraveバイナリ（またはChromiumベースのブラウザ）に設定し、Gatewayを再起動します。
[Browser](/tools/browser#use-brave-or-another-chromium-based-browser) の完全な設定例を参照してください。

## リモートゲートウェイとノード

### ゲートウェイとノードの間でコマンドが伝播する方法

Telegram メッセージは **ゲートウェイ** によって処理されます。 3. ゲートウェイはエージェントを実行し、その後にのみノードツールが必要になった場合に **Gateway WebSocket** 経由でノードを呼び出します:

Telegram → Gateway → Agent → `node.*` → ノード → Gateway → Telegram

ノードはインバウンドプロバイダトラフィックを表示しません。ノードRPC呼び出しのみを受信します。

### ゲートウェイがリモートホストされている場合、エージェントがどのようにコンピュータにアクセスできますか？

簡単な答え: **コンピュータをノードとしてペアリング**。 4. ゲートウェイは別の場所で動作しますが、Gateway WebSocket を介してローカルマシン上の `node.*` ツール（screen、camera、system）を呼び出すことができます。

典型的な設定:

1. 常時オンホスト(VPS/ホームサーバー)でゲートウェイを実行します。
2. ゲートウェイホストとコンピューターを同じテールネットに置きます。
3. Gateway WS が到達可能であることを確認します (tailnet バインドまたは SSH トンネル)。
4. macOS アプリをローカルに開き、**Remote over SSH** モード (または直接テールネット)
   で接続してノードとして登録できます。
5. ゲートウェイのノードを承認:

   ```bash
   openclaw nodes pending
   openclaw nodes approve <requestId>
   ```

個別の TCP ブリッジは必要ありません。ノードはゲートウェイの WebSocket に接続します。

セキュリティリマインダー: macOS ノードをペアリングすることで、そのマシン上で `system.run` を使用できます。
信頼できるデバイスをペアリングし、 [Security](/gateway/security) を確認してください。

Docs: [Nodes](/nodes), [Gateway protocol](/gateway/protocol), [macOS remode](/platforms/mac/remote), [Security](/gateway/security).

### テールスケールは接続されていますが、返信がありません。

基本を確認します。

- ゲートウェイが実行中: `openclawゲートウェイの状態`
- ゲートウェイの状態: `openclawステータス`
- チャネルの状態: `openclaw channels status`

次に認証とルーティングを確認します。

- Tailscale Servを使用する場合は、`gateway.auth.allowTailscale`が正しく設定されていることを確認してください。
- SSH トンネル経由で接続する場合は、ローカルトンネルが上にあり、正しいポートでポイントがあることを確認します。
- 許可リスト(DMまたはグループ)にアカウントが含まれていることを確認します。

Docs: [Tailscale](/gateway/tailscale), [Remote access](/gateway/remote), [Channels](/channels).

### 2つのOpenClawインスタンスがお互いにローカルVPSと通信できます。

はい 5. 組み込みの「ボット間」ブリッジはありませんが、いくつかの信頼できる方法で配線できます:

**簡単:** 両方のボットがアクセスできる通常のチャットチャンネルを使用してください (TELEGram/Slack/WhatsApp)。
ボットAからBotBにメッセージを送信し、いつものようにBotBに返信させます。

**CLI bridge (generic):** 他の Gateway を
`openclaw agent --message ... --deliver`, ほかのボット
がリッスンするチャットをターゲットにしています。 6. 1 つのボットがリモート VPS 上にある場合、SSH/Tailscale 経由でそのリモート Gateway を指すように CLI を設定します（[リモートアクセス](/gateway/remote)参照）。

パターンの例 (ターゲットゲートウェイに到達できるマシンから実行):

```bash
openclawエージェント --message "Hello from local bot" --delivery --channel telegram --reply-to <chat-id>
```

ヒント: ガードレールを追加すると、2つのボットが無限にループしないようにします(メンションのみ、チャネル
許容リスト、または「ボットメッセージに返信しない」ルール)。

Docs: [リモートアクセス](/gateway/remote), [Agent CLI](/cli/agent), [Agent send](/tools/agent-send).

### 複数のエージェントにVPSを分離する必要がありますか？

いいえ. 1 つのゲートウェイでは、複数のエージェントをホストできます。それぞれに独自のワークスペース、モデルデフォルト、
、ルーティングがあります。 7. それが通常の構成であり、エージェントごとに 1 台の VPS を実行するよりも、はるかに安価でシンプルです。

8. 強力な分離（セキュリティ境界）が必要な場合や、共有したくない大きく異なる設定がある場合にのみ、別々の VPS を使用してください。 それ以外の場合は、1つのゲートウェイと
   で複数のエージェントまたはサブエージェントを使用してください。

### VPSからSSHではなく個人用ラップトップでノードを使用する利点はありますか?

9. はい。ノードはリモート Gateway からラップトップに到達するための第一級の手段であり、シェルアクセス以上のことを可能にします。 10. Gateway は macOS/Linux（Windows は WSL2 経由）で動作し、軽量です（小規模な VPS や Raspberry Pi クラスのマシンで十分。RAM 4 GB あれば余裕です）。そのため、常時稼働のホスト + ラップトップをノードとして使う構成が一般的です。

- **インバウンドSSHは必要ありません。** ノードはゲートウェイWebSocketに接続し、デバイスのペアリングを使用します。
- **より安全な実行コントロール** `system.run` はそのラップトップのノードの許可リスト/承認によって与えられています。
- **より多くのデバイスツール** ノードは`system.run`に加えて`canvas`、`camera`、そして`screen`を公開します。
- 11. **ローカルブラウザ自動化。** Gateway は VPS 上に置いたまま、Chrome はローカルで実行し、Chrome 拡張機能 + ラップトップ上のノードホストで制御を中継します。

SSHはアドホックシェルアクセスには問題ありませんが、進行中のエージェントワークフローや
デバイスの自動化ではノードは簡単です。

Docs: [Nodes](/nodes), [Chrome extension](/cli/nodes), [Chrome extension](/tools/chrome-extension).

### 2台目のラップトップにインストールするかノードを追加する必要があります

2 台目のラップトップで **ローカルツール** (スクリーン/カメラ/exec) のみが必要な場合は、
**node** として追加します。 これにより単一のゲートウェイが保持され、設定が重複しないようになります。 ローカルノードツールは
現在 macOSのみですが、他のOSに拡張する予定です。

**ハードアイソレーション**または完全に別々のボットが必要な場合にのみ、2つ目のゲートウェイをインストールしてください。

Docs: [Nodes](/nodes), [Multiple gateways](/cli/nodes), [Multiple gateways](/gateway/multiple-gateways).

### Do nodes runs a gateway service

いいえ. 分離されたプロファイルを意図的に実行しない限り、**1つのゲートウェイ** だけがホストごとに実行されます ([Multiple gateways](/gateway/multiple-gateways)を参照してください)。 ノードは、
をゲートウェイ(iOS/Androidノード、メニューバーアプリのmacOS「ノードモード」)に接続する周辺機器です。 ヘッドレスノード
ホストと CLI コントロールについては、[Node host CLI](/cli/node)を参照してください。

`gateway`、`discovery`、および `canvasHost`を変更するには、完全な再起動が必要です。

### API RPCの設定を適用する方法はありますか？

はい `config.apply` は、完全な設定を検証+書き込み、操作の一部としてゲートウェイを再起動します。

### configapply wished my config How do I recover this

`config.apply` は **config** 全体を置き換えます。 部分的なオブジェクトを送信すると、
以外のすべてが削除されます。

回復:

- バックアップから復元します (git または `~/.openclaw/openclaw.json` をコピーしました)。
- バックアップがない場合は、`openclaw doctor` を再実行し、チャンネル/モデルを再設定します。
- これが想定外の場合は、バグを修正し、最後に既知の設定やバックアップを含めてください。
- ローカルのコーディングエージェントは、しばしばログや履歴から動作する設定を再構築できます。

回避方法：

- 小さな変更には、 `openclaw設定セット` を使用します。
- 対話的な編集には`openclaw設定`を使用してください。

Docs: [Config](/cli/config), [Configure](/cli/configure), [Doctor](/gateway/doctor).

### 最初にインストールするための最小限の正常な設定とは何ですか？

```json5
{
  agents: { defaults: { workspace: "~/.openclaw/workspace" } },
  channels: { whatsapp: { allowFrom: ["+15555550123"] } },
}
```

ワークスペースを設定し、誰がボットをトリガーできるかを制限します。

### VPSでTailscaleを設定し、Macから接続する方法

最小ステップ：

1. **VPSにインストール+ログイン**

   ```bash
   curl -fsSL https://tailscale.com/install.sh | sh
   sudo tailscale up
   ```

2. **Macにインストール+ログイン**
   - Tailscale アプリを使用して、同じテールネットにサインインします。

3. **MagicDNSを有効にする（推奨）**
   - Tailscale管理コンソールでMagicDNSを有効にすると、VPSの名前が安定しています。

4. **tailnet ホスト名を使用します**
   - SSH: `ssh user@your-vps.tailnet-xxxx.ts.net`
   - Gateway WS: `ws://your-vps.tailnet-xxxx.ts.net:18789`

SSH なしで Control UI を使用する場合は、VPS上で Tailscale Serve を使用します。

```bash
openclaw gateway --tailscale serve
```

これにより、ゲートウェイはループバックに束縛され、tailscale経由でHTTPSが公開されます。 [Tailscale](/gateway/tailscale) を参照してください。

### Mac ノードをリモート Gateway Tailscale Serve に接続する方法

**Gateway Control UI + WS** を公開します。 ノードは、同じ Gateway WS エンドポイントに接続します。

推奨設定:

1. **VPS+Macが同じテールネット上にあることを確認してください**。
2. **リモートモードでmacOSアプリを使用します** (SSHターゲットはテールネットのホスト名にできます)。
   アプリはゲートウェイポートをトンネルし、ノードとして接続します。
3. **ゲートウェイのノードを承認**：

   ```bash
   openclaw nodes pending
   openclaw nodes approve <requestId>
   ```

Docs: [Gateway protocol](/gateway/protocol), [Discovery](/gateway/discovery), [macOS リモートモード](/platforms/mac/remote).

## Env var と .env の読み込み

### OpenClawが環境変数をロードする方法

OpenClawは親プロセス(シェル、起動/システム、CIなど)からenv varsを読み込みます。 さらに負荷がかかります

- 現在の作業ディレクトリから `.env`
- `~/.openclaw/.env`（別名 `$OPENCLAW_STATE_DIR/.env`）にあるグローバルフォールバック `.env`

どちらの `.env` ファイルも、既存の環境変数を上書きしません。

コンフィグでインラインenv var を定義することもできます (プロセス env に欠落している場合にのみ適用されます):

```json5
{
  env: {
    OPENROUTER_API_KEY: "sk-or-...",
    vars: { GROQ_API_KEY: "gsk-..." },
  },
}
```

優先順位とソースの詳細は [/environment](/help/environment) を参照してください。

### 私はサービスを介してゲートウェイを開始し、私のenvのvarsは消えました 今何を今。

2つの一般的な修正:

1. 欠けているキーを `~/.openclaw/.env` に入れると、サービスがシェルの env を継承していなくても取り上げられるようになります。
2. シェルのインポートを有効にする (オプトインの利便性):

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

これはログインシェルを実行し、期待されるキーのみをインポートします(決して上書きしません)。 Env var var equents:
`OPENCLAW_LOAD_SHELL_ENV=1` , `OPENCLAW_SHELL_ENV_TIMEOUT_MS=15000` .

### COPILOTGITHUBTOKENを設定しましたが、モデルの状態はShellenvをOFFにしています。

`openclaw models status` は **shell env import** が有効になっているかどうかを報告します。 12. "Shell env: off" は、環境変数が欠けているという意味 **ではありません**。単に OpenClaw がログインシェルを自動で読み込まないという意味です。

Gateway がサービスとして実行されている場合 (launchd/systemd) は、シェルの
環境を継承しません。 以下のいずれかを実行して修正します。

1. トークンを `~/.openclaw/.env` に入れます。

   ```
   COPILOT_GITHUB_TOKEN=...
   ```

2. またはシェルインポート (`env.shellEnv.enabled: true`) を有効にします。

3. 設定`env`ブロックに追加します（不足している場合にのみ適用されます）。

次にゲートウェイを再起動し、再確認します:

```bash
openclaw models status
```

コピロットトークンは `COPILOT_GITHUB_TOKEN` (`GH_TOKEN` / `GITHUB_TOKEN`) から読み込まれます。
[/concepts/model-providers](/concepts/model-providers) と [/environment](/help/environment)を参照してください。

## セッションと複数のチャット

### 新鮮な会話を始めるには

スタンドアロンメッセージとして `/new` または `/reset` を送信します。 13. [セッション管理](/concepts/session)を参照してください。

### 新しいメッセージを送信しない場合、セッションが自動的にリセットされます

はい セッションは `session.idleMinutes` (デフォルト **60**) の後に失効します。 **next**
メッセージは、そのチャットキーのセッションIDを開始します。 これは、
トランスクリプトを削除しません。新しいセッションを開始するだけです。

```json5
{
  session: {
    idleMinutes: 240,
  },
}
```

### OpenClawインスタンスのチームを1つのCEOと多くのエージェントにする方法はありますか？

はい、**マルチエージェントルーティング** と **サブエージェント** を使用します。 コーディネータ
エージェントと複数のワーカーエージェントを独自のワークスペースとモデルで作成できます。

とはいえ、これは**楽しい実験**として最もよく見られます。 トークンは重く、別々のセッションで1つのボットを使用するよりも
効率が低いことがよくあります。 14. 私たちが想定している典型的なモデルは、会話するボットは 1 つで、並行作業のために複数のセッションを使い分けるというものです。 その
ボットは、必要に応じてサブエージェントを生成することもできます。

Docs: [マルチエージェントルーティング](/concepts/multi-agent), [Sub-agents](/tools/subagents), [Agents CLI](/cli/agents).

### コンテキストが途中で切り捨てられたのはなぜですか?

セッションコンテキストはモデルウィンドウによって制限されます。 長いチャット、大きなツール出力、または多くの
ファイルが圧縮または切り捨てを引き起こす可能性があります。

何が役立ちますか:

- ボットに現在の状態をまとめてファイルに書き込むように依頼します。
- 長いタスクの前に `/compact` を、トピックを切り替えるときは `/new` を使います。
- ワークスペースで重要なコンテキストを保持し、ボットに読み返すように求めます。
- メインチャットが小さくなるように、長または並列作業にサブエージェントを使用します。
- これが頻繁に発生した場合は、コンテキストウィンドウが大きいモデルを選択します。

### OpenClawを完全にリセットするにはどうすればいいですか？しかし、それをインストールしておいてください

リセットコマンドを使用します。

```bash
openclaw reset
```

非対話型フルリセット:

```bash
openclawリセット--scope full --yes --non-interactive
```

次に、オンボーディングを再実行します:

```bash
openclaw onboard --install-daemon
```

配列は置換

- オンボーディングウィザードでは、既存の設定が表示されている場合は **リセット** も提供されます。 [Wizard](/start/wizard) を参照してください。
- プロファイル(`--profile` / `OPENCLAW_PROFILE`)を使用した場合、それぞれの状態ディレクトリをリセットします(デフォルトは `~/.openclaw-<profile>`)。
- 開発者リセット: `openclaw gateway --dev --reset` (dev-only; wipes dev config + credentials + sessions + workspace).

### コンテキストが大きすぎます。リセットまたはコンパクトにするには、エラーが発生しました

次のいずれかを使用します。

- **コンパクト** (会話を保持しますが、古い順番をまとめました):

  ```
  /compact
  ```

  または `/compact <instructions>` を使用して概要を説明します。

- **リセット** (同じチャットキーの新しいセッションID):

  ```
  /new
  /reset
  ```

もしそれが起こり続けるなら:

- 古いツール出力をトリムするために **session pruning** (`agents.defaults.contextPruning`) を有効にするか調整します。
- 大きなコンテキストウィンドウを持つモデルを使用します。

Docs: [Compaction](/concepts/compaction), [Session pruning](/concepts/session-pruning), [セッション管理](/concepts/session).

### LLM要求が拒否されたメッセージを見る理由NcontentXtooluseinputフィールドが必要

これはプロバイダのバリデーションエラーです。モデルは
`input` を使わずに `tool_use` ブロックを発行しました。 これは通常、セッション履歴が古いまたは破損していることを意味します(しばしば長いスレッド
またはツール/スキーマの変更後)。

修正: `/new` (スタンドアロンメッセージ) で新しいセッションを開始します。

### 30分ごとにハートビートメッセージが表示されるのはなぜですか？

ハートビートはデフォルトで**30m**ごとに実行されます。 調整または無効化:

```json5
15. {
  agents: {
    defaults: {
      heartbeat: {
        every: "2h", // or "0m" to disable
      },
    },
  },
}
```

`HEARTBEAT.md` が存在するが、実質的に空（空行と `# Heading` のような Markdown 見出しのみ）の場合、OpenClaw は API コール節約のためにハートビート実行をスキップします。ファイルが存在しない場合でも、ハートビートは実行され、モデルが何をするかを判断します。
ファイルが存在しない場合でも、ハートビートは実行され、モデルが何をするかを判断します。

エージェント毎のオーバーライドは `agents.list[].heartbeat` を使用します。 ドキュメント: [Heartbeat](/gateway/heartbeat).

### WhatsAppグループにボットアカウントを追加する必要があります

いいえ. OpenClawは**あなた自身のアカウント**で動作しますので、あなたがグループにいるなら、OpenClawはそれを見ることができます。
デフォルトでは、グループの返信は送信者(`groupPolicy: "allowlist"`)を許可するまでブロックされます。

**あなた** だけがグループの返信をトリガーできるようにしたい場合:

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

### WhatsAppグループのJIDを取得する方法

オプション1(最速):テールログとグループ内のテストメッセージの送信:

```bash
openclawログ --follow --json
```

16. `@g.us` で終わる `chatId`（または `from`）を探してください。例:
    `1234567890-1234567890@g.us`。

オプション2(既に設定済み/許可されている場合): configのリストグループ:

```bash
openclawディレクトリグループリスト --channel whatsapp
```

Docs: [WhatsApp](/channels/whatsapp), [Directory](/cli/directory), [Logs](/cli/logs).

### なぜグループ内でOpenClawの返信がないのか

2つの一般的な原因:

- メンションゲートがオン（デフォルト）です。 Botを@メンションする必要があります（または`mentionPatterns`にマッチします）。
- `channels.whatsapp.groups`を\`"\*"なしで設定し、グループは許可されていません。

[Groups](/channels/groups) と [Group messages](/channels/group-messages) を参照してください。

### Do groupssthreads share context with DM

ダイレクトチャットはデフォルトでメインセッションに折りたたまれます。 グループ/チャンネルには独自のセッションキーがあり、Telegramのトピック/Discordのスレッドは別々のセッションです。 [Groups](/channels/groups) と [Group messages](/channels/group-messages) を参照してください。

### 作成できるワークスペースとエージェントの数

ハードリミットはありません。 数十(たとえ数百人)は大丈夫ですが、以下の条件で見ることができます。

- **ディスクの成長:** セッション + トランスクリプトは `~/.openclaw/agents/<agentId>/sessions/` の下で実行されます。
- **トークンコスト:** エージェントの数が多ければ多いほど、モデルの使用量が多くなります。
- **Opsオーバーヘッド：** エージェント毎の認証プロファイル、ワークスペース、チャンネルルーティング。

ヒント:

- エージェント (`agents.defaults.workspace`) につき 1 つの **アクティブ** ワークスペースを保持します。
- ディスクが成長すると古いセッション(JSONLまたは保存エントリを削除)を削除します。
- 浮遊ワークスペースとプロフィールの不一致を見つけるには、`openclaw doctor`を使用します。

### 複数のボットやチャットを同時に実行することはできますか? どのように設定すればいいですか?

はい **Multi-Agent Routing** を使用して、複数の孤立したエージェントを実行し、
channel/account/peer による受信メッセージをルーティングします。 Slackはチャンネルとしてサポートされており、特定のエージェントに紐付けることができます。

17. ブラウザアクセスは強力ですが、「人間ができることは何でもできる」わけではありません。アンチボット、CAPTCHA、MFA によって自動化が阻止される場合があります。 最も信頼性の高いブラウザ制御を行うには、ブラウザを実行するマシンのChrome拡張リレー
    を使用します(どこにでもゲートウェイを維持します)。

ベストプラクティスの設定:

- 常時オンゲートウェイホスト (VPS/Mac mini)
- ロールごとに1つのエージェント(バインディング)。
- Slackチャンネルはエージェントに紐付けられています。
- 必要に応じて、拡張リレー(またはノード)を介したローカルブラウザ。

Docs: [マルチエージェントルーティング](/concepts/multi-agent), [Slack](/channels/slack),
[Browser](/tools/browser), [Chrome extension](/tools/chrome-extension), [Nodes](/nodes).

## モデル: デフォルト、選択、エイリアス、切り替え

### デフォルトのモデルは何ですか？

OpenClawのデフォルトモデルは以下のように設定されています:

```
agents.defaults.model.primary
```

モデルは `provider/model` として参照されます(例: `anthropic/claude-opus-4-6`)。 プロバイダを省略した場合、OpenClawは現在一時的な非推奨のフォールバックとして`anthropic`を想定していますが、`provider/model`を設定する必要があります。

### どのモデルをお勧めしますか？

**Recommended default:** `anthropic/claude-opus-4-6`
**良い選択肢** `anthropic/claude-sonnet-4-5`
**信頼性の高い(より少ない文字):** `openai/gpt-5.2` - Opusとほぼ同じくらい、性格が低い。
**Budget:** `zai/glm-4.7`.

MiniMax M2.1 には独自のドキュメントがあります: [MiniMax](/providers/minimax) と
[ローカルモデル](/gateway/local-models)。

親指のルール: 高ステークスの仕事のために**あなたが手に入れることができる最良のモデル**を使用し、ルーチンチャットや要約のための安価な
モデルを使用してください。 18. エージェントごとにモデルをルーティングし、サブエージェントを使って長時間タスクを並列化できます（各サブエージェントはトークンを消費します）。 [Models](/concepts/models) と
[Sub-agents](/tools/subagents) を参照してください。

強い警告：弱い/過剰にクオンタイズされたモデルは、
注入と安全でない動作に対してより脆弱です。 [Security](/gateway/security) を参照してください。

その他のコンテキスト: [Models](/concepts/models).

### 自己ホスト型モデルを使用できますか? llamacpp vLLM Ollama

はい ローカルサーバーが OpenAI 互換の API を公開している場合、
カスタムプロバイダを指定できます。 Ollamaは直接サポートされており、最も簡単なパスです。

セキュリティ上の注意: 小規模または大幅にクオンタイズされたモデルは、
注射のプロンプトに対してより脆弱です。 ツールを使用できるボットには、**大きなモデル** を強くお勧めします。
それでも小さなモデルが必要な場合は、サンドボックス化と厳格なツールの許可を有効にしてください。

Docs: [Ollama](/providers/ollama), [ローカルモデル](/gateway/local-models),
[モデルプロバイダ](/concepts/model-providers), [Security](/gateway/security),
[Sandboxing](/gateway/sandboxing).

### 設定を消去せずにモデルを切り替える方法

**modelコマンド** を使用するか、**model** フィールドのみを編集します。 完全な設定の置き換えは避けてください。

安全なオプション:

- `/model` in chat (quick, persession)
- `openclaw models set ...` (model configだけ更新)
- `openclaw configure --section model` (interactive)
- `~/.openclaw/openclaw.json`で`agents.defaults.model`を編集します

config全体を置き換える場合を除き、部分的なオブジェクトである `config.apply` は避けてください。
設定を上書きした場合は、バックアップから復元するか、`openclaw doctor`を再実行して修復します。

Docs: [Models](/concepts/models), [Configure](/cli/configure), [Config](/cli/config), [Doctor](/gateway/doctor).

### OpenClaw、Flawd、およびKrillがモデルで使用するもの

- **OpenClaw + Flawd:** Anthropic Opus (`anthropic/claude-opus-4-6`) - [Anthropic](/providers/anthropic).
- **Krill:** MiniMax M2.1 (`minimax/MiniMax-M2.1`) - see [MiniMax](/providers/minimax).

### 再起動せずにモデルをオンザフライで切り替える方法

`/model` コマンドをスタンドアロンメッセージとして使用します。

```
/model sonnet
/model haiku
/model opus
/model gpt
/model gpt-mini
/model gemini
/model gemini-flash
```

`/model`、`/modellist`、または`/modelstatus`で利用可能なモデルをリストすることができます。

`/model` (および `/model list`) はコンパクトで番号のあるピッカーを表示します。 数字で選択:

```
/model 3
```

プロバイダに特定の認証プロファイルを強制することもできます(セッションごと):

```
/model opus@anthropic:default
/model opus@anthropic:work
```

ヒント: `/model status` は、どのエージェントがアクティブかを示します。どの`auth-profiles.json`ファイルが使用されているか、どの認証プロファイルが次に試みられるかを示します。
また、設定されたプロバイダエンドポイント (`baseUrl`) と API モード (`api`) が利用可能になった場合にも表示されます。

**プロフィールで設定したプロフィールのピン留めを解除するにはどうすればいいですか**

`/model` を `@profile` のサフィックスに \*\*without \*\* してください:

```
/model anthropic/claude-opus-4-6
```

デフォルトに戻りたい場合は、 `/model` から選択します(または `/model <default provider/model> `を送信します)。
どの認証プロファイルが有効か確認するには、`/model status` を使用します。

### 毎日のタスクにGPT 5.2を、コーディングにコーディングにコーディング5.3を使用できますか?

はい デフォルトとして設定し、必要に応じて切り替えます：

- **クイックスイッチ（セッションごと）** `/model gpt-5.2` を毎日のタスクに使用します。`/model gpt-5.3-codex` をコーディングに使用します。
- **Default + switch:** `agents.defaults.model.primary`を`openai/gpt-5.2`に設定し、コーディング時には`openai-codex/gpt-5.3-codex`に切り替えます。
- **サブエージェント:** 異なるデフォルトモデルを持つサブエージェントにコーディングタスクをルーティングします。

[Models](/concepts/models) と [Slash commands](/tools/slash-commands) を参照してください。

### Modelが許可されていないと返信できないのはなぜですか？

`agents.defaults.models` が設定されている場合、`/model` の **allowlist** となり、
セッションが上書きされます。 そのリストにないモデルを選択すると、以下のように戻ります。

```
Model "provider/model" is not allowed. Use /model to list available models.
```

このエラーは通常の返信の代わりに\*\*返されます。 修正:
`agents.defaults.models` にモデルを追加するか、許容リストを削除するか、`/model list` からモデルを選択します。

### Unknown model minimaxMiniMaxM21 が表示される理由

これは**プロバイダが設定されていない** (MiniMaxプロバイダ設定や認証
プロファイルが見つからなかった) ので、モデルは解決できません。 この検出のための修正は、 **2026.1.12** の
です(書き込み時に解除されません)。

チェックリストを修正:

1. **2026.1.12** にアップグレードしてから、ゲートウェイを再起動してください。
2. MiniMax が設定されていること (ウィザードまたは JSON)、または MiniMax API キー
   がenv/auth プロファイルに存在していることを確認してください。
3. 正確なモデル id (大文字と小文字を区別する): `minimax/MiniMax-M2.1` または
   `minimax/MiniMax-M2.1-lightning` を使用します。
4. Run:

   ```bash
   openclaw models list
   ```

   を選択し、リストから選択します(もしくはチャットの `/model list` )。

[MiniMax](/providers/minimax) と [Models](/concepts/models) を参照してください。

### MiniMaxをデフォルトとして、OpenAIを複雑なタスクに使用できますか?

はい **MiniMaxをデフォルト**として使用し、必要に応じて**セッションごとに**モデルを切り替えます\*\*。
フォールバックは**エラー**のためのもので、「ハードタスク」ではありません。ですから、`/model` または別のエージェントを使用してください。

**オプション A: セッションごとの切り替え**

```json5
19. {
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

**Option B: エージェントを分離**

- エージェント A デフォルト: MiniMax
- エージェントBのデフォルト: OpenAI
- エージェントでルート化するか、 `/agent` を使用して切り替えます

ドキュメント: [Models](/concepts/models), [マルチエージェントルーティング](/concepts/multi-agent), [MiniMax](/providers/minimax), [OpenAI](/providers/openai).

### Opus sonnet gpt 組み込みショートカット

はい OpenClawはいくつかのデフォルトの省略形を出荷します(`agents.defaults.models`にモデルが存在する場合のみ適用されます)。

- `opus` → `anthropic/claude-opus-4-6`
- `sonnet` → `anthropic/claude-sonnet-4-5`
- `gpt` → `openai/gpt-5.2`
- `gpt-mini` → `openai/gpt-5-mini`
- `gemini` → `google/gemini-3-pro-preview`
- `gemini-flash` → `google/gemini-3-flash-preview`

同じ名前で独自のエイリアスを設定すると、あなたの値が勝利します。

### モデルショートカットのエイリアスを定義する方法

エイリアスは `agents.defaults.models.<modelId>.alias`. 2026-02-08T09:22:13Z

```json5
20. {
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

次に、`/model sonnet` (サポートされている場合は `/<alias>` )がそのモデルIDを解決します。

### OpenRouterやZAIなどの他のプロバイダからモデルを追加する方法

OpenRouter (ペイパートークン; 多くのモデル):

```json5
21. {
  agents: {
    defaults: {
      model: { primary: "openrouter/anthropic/claude-sonnet-4-5" },
      models: { "openrouter/anthropic/claude-sonnet-4-5": {} },
    },
  },
  env: { OPENROUTER_API_KEY: "sk-or-..." },
}
```

Z.AI (GLMモデル):

```json5
22. {
  agents: {
    defaults: {
      model: { primary: "zai/glm-4.7" },
      models: { "zai/glm-4.7": {} },
    },
  },
  env: { ZAI_API_KEY: "..." },
}
```

プロバイダ/モデルを参照していて、必要なプロバイダキーが存在しない場合、ランタイム認証エラーが表示されます (e. を選択します。 \`プロバイダー "zai" の API キーが見つかりませんでした)。

**新しいエージェントを追加した後、プロバイダのAPIキーが見つかりませんでした**

これは通常、**新しいエージェント** に空の認証ストアがあることを意味します。 23. 認証はエージェントごとで、次の場所に保存されます:

```
~/.openclaw/agents/<agentId>/agent/auth-profiles.json
```

修正方法:

- `openclaw agents add <id>` を実行し、ウィザード中に認証を設定します。
- もしくは、メインエージェントの `agentDir` から `auth-profiles.json` を新しいエージェントの `agentDir` にコピーします。

`agentDir`をエージェント間で再利用することはできません。認証/セッションの衝突を引き起こします。

## モデルのフェイルオーバーと "すべてのモデルが失敗しました"

### フェイルオーバーの仕組み

フェイルオーバーは2つの段階で発生します:

1. **認証プロファイルのローテーション**
2. `agents.defaults.model.fallbacks` 内の次のモデルへの **モデルフォールバック**。

失敗したプロファイルにクールダウンが適用される（指数関数的バックオフ）ため、OpenClawはプロバイダがレート制限または一時的に失敗しても応答し続けることができます。

### このエラーが意味するもの

```
プロファイル "anthropic:default" の資格情報が見つかりません。
```

これは、認証プロファイルID `anthropic:default` の使用を試みたシステムですが、期待される認証ストアで認証情報が見つかりませんでした。

### プロファイルanthropicdefault の資格情報が見つからない場合のチェックリストを修正しました。

- **認証プロファイルが存在する場所を確認** (新しいパスとレガシーパス)
  - 現在: `~/.openclaw/agents/<agentId>/agent/auth-profiles.json`
  - レガシー: `~/.openclaw/agent/*` (`openclaw doctor`によって移行)
- **あなたの env var がゲートウェイによってロードされていることを確認します**
  - シェルで `ANTHROPIC_API_KEY` を設定し、systemd/launchd 経由で Gateway を実行した場合、それを継承しない可能性があります。 `~/.openclaw/.env` または `env.shellEnv` を有効にします。
- **正しいエージェントを編集していることを確認してください**
  - 複数エージェントのセットアップは、複数の `auth-profiles.json` ファイルがあることを意味します。
- **Sanity-check model/auth status**
  - 設定されたモデルとプロバイダが認証されているかどうかを確認するには、`openclawモデルのステータス` を使用してください。

**プロファイルのアンスロピックの資格情報が見つからないチェックリストを修正**

つまり、ランはAnthropicの認証プロファイルに固定されていますが、ゲートウェイ
は認証ストアでは見つかりません。

- **setup-tokenを使用**
  - `claude setup-token` を実行し、 `openclaw models setup-token ---provider anthropic` を貼り付けます。
  - トークンが別のマシンで作成された場合は、 `openclaw models auth paste-token ---provider anthropic` を使用してください。

- **代わりにAPIキーを使用したい場合**
  - `~/.openclaw/.env`に`ANTHROPIC_API_KEY`を**ゲートウェイホスト**に置きます。
  - ピン留めされたプロファイルを強制的に消去します:

    ```bash
    openclaw models auth order clear --provider anthophic
    ```

- **ゲートウェイホストでコマンドを実行していることを確認します**
  - リモートモードでは、ラップトップではなくゲートウェイマシン上で認証プロファイルが実行されます。

### なぜそれはまたGoogle Geminiを試して失敗したか

モデル設定にGoogle Geminiがフォールバックとして含まれている場合(または、ジェミニ短縮に切り替えた場合)、OpenClawはモデルのフォールバック時にそれを試みます。 Googleの資格情報を設定していない場合は、プロバイダ「google」のAPIキーが見つかりません。

修正: Google authを提供するか、`agents.defaults.model.fallbacks` / エイリアスでGoogleモデルを削除/回避するか、フォールバックがそこにルートされないように修正しました。

**LLMリクエストはメッセージの思考を拒否しました署名を必要とするgoogle antigravity**

原因: セッション履歴には、**署名のないブロックを考える** が含まれています (多くの場合、
中断/部分的なストリーム)。 Googleアンチグラビティは、考えるブロックに署名を必要とします。

修正:Google Antigravity Claudeの署名のない思考ブロックをOpenClawが取り除くようになりました。 それでも表示される場合は、**新しいセッション** を開始するか、エージェントの `/thinking off` を設定します。

## 認証プロファイル：それらが何であるかとそれらを管理する方法

関連: [/concepts/oauth](/concepts/oauth) (OAuthフロー、トークンストレージ、マルチアカウントパターン)

### 認証プロファイルとは

認証プロファイルは、プロバイダに関連付けられた名前付き資格情報レコード (OAuth または API キー) です。 プロファイルの有効期限:

```
~/.openclaw/agents/<agentId>/agent/auth-profiles.json
```

### 典型的なプロフィールIDとは？

OpenClawは次のようなプロバイダ接頭辞付きIDを使用します:

- `anthropic:default` (メールIDが存在しない場合に一般的)
- `anthropic:<email>` OAuth identities
- 選択したカスタム ID (例: `anthropic:work`)

### どの認証プロファイルが最初に試されたかを制御できますか？

はい Configはプロファイルのオプションメタデータとプロバイダごとの順序(`auth.order)をサポートしています。<provider>`). これは **シークレットを保存しません** 。ID をプロバイダ/モードにマップし、ローテーション順序を設定します。

OpenClawは一時的にプロファイルをスキップする場合があります。もしそれが短い**クールダウン**（レート制限/タイムアウト/認証失敗）または**無効化**状態（請求/クレジット不足）になっている場合。 これを調べるには、 `openclaw models status --json` を実行し、 `auth.unusableProfiles` を確認してください。 チューニング: `auth.cooldowns.billingBackoffHours*`

**per-agent** のオーダーオーバーライド（エージェントの `auth-profiles.json` に格納されています）を CLI 経由で設定することもできます：

```bash
24. # 設定されたデフォルトエージェントが既定（--agent を省略）
openclaw models auth order get --provider anthropic

# ローテーションを単一プロファイルに固定（これのみ試行）
openclaw models auth order set --provider anthropic anthropic:default

# または明示的な順序を設定（プロバイダ内でのフォールバック）
openclaw models auth order set --provider anthropic anthropic:work anthropic:default

# オーバーライドをクリア（config の auth.order / ラウンドロビンに戻す）
openclaw models auth order clear --provider anthropic
```

特定のエージェントをターゲットにするには:

```bash
openclaw モデル auth order set --provider anthropic --agent main anthropic:default
```

### OAuth vs API キー

OpenClawは両方をサポートしています:

- **OAuth** は頻繁にサブスクリプションアクセスを利用します(該当する場合)。
- **API キー** はトークンごとの支払いを使用します。

ウィザードは、Anthropic setup-token と OpenAI Codex OAuth を明示的にサポートしており、API キーを保存できます。

## ゲートウェイ：ポート、"すでに実行中"、およびリモートモード。

### ゲートウェイのポート番号

`gateway.port` はWebSocket + HTTP (Control UI、フックなど) の単一多重化ポートを制御します。

優先順位:

```
--port > OPENCLAW_GATEWAY_PORT > gateway.port > デフォルト 18789
```

### なぜopenclawゲートウェイの状態はランタイムが実行されているがRPCプローブが失敗していると言うのか？

"running" は **スーパーバイザの** ビュー (launchd/systemd/schtasks) であるためです。 RPCプローブは、CLIがゲートウェイのWebSocketに接続し、`status`を呼び出します。

`openclaw gateway status` を使用して、以下の行を信頼してください。

- `プローブターゲット：` （実際にプローブが使用したURL）
- `聞き取り:` (ポートで実際にバインドされているもの)
- `Last gateway error:` (プロセスが生きているが、ポートがリッスンされていないときに一般的な原因)

### なぜopenclawゲートウェイステータスがConfigcliとConfigサービスが異なるのか?

サービスが別の実行中に1つの設定ファイルを編集しています（しばしば`--profile` / `OPENCLAW_STATE_DIR` 不一致）。

修正方法:

```bash
openclaw gateway install --force
```

サービスを使用するのと同じ `--profile` / 環境から実行します。

### 別のゲートウェイインスタンスが既にリッスンしているのは何ですか？

OpenClawは起動時にすぐにWebSocketリスナーをバインドしてランタイムロックを強制します(デフォルトは`ws://127.0.0.1:18789`)。 バインドが `EADDRINUSE` で失敗した場合、別のインスタンスがすでにリッスンしていることを示す`GatewayLockError`をスローします。

もう一方のインスタンスを停止し、ポートを解放するか、`openclaw gateway --port <port> `で実行します。

### リモートモードクライアントでOpenClawを実行する方法は、他のゲートウェイに接続します

\`gateway.mode: "remote"を設定し、必要に応じてトークン/パスワードを持つリモートWebSocket URLをポイントします:

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

配列は置換

- `openclaw gateway` は `gateway.mode` が `local` (またはオーバーライドフラグを渡す) のときにのみ起動します。
- macOS アプリは、設定ファイルとスイッチモードがこれらの値が変更されたときに動作するのを監視します。

### コントロールUIが許可されていないか、再接続を続けています。

あなたのゲートウェイは認証が有効になっている(`gateway.auth.*`)で動作していますが、UIは一致するトークン/パスワードを送信していません。

事実 (コードから):

- Control UI は、ブラウザーの localStorage キー `openclaw.control.settings.v1` にトークンを保存します。

修正方法:

- 最速: `openclawダッシュボード` (印刷 + ダッシュボードのURLをコピーして開こうとします。頭のない場合はSSHヒントを表示します)。
- トークンがまだない場合: `openclaw doctor --generate-gateway-token` 。
- リモートの場合、`ssh -N -L 18789:127.0.0.1:18789 user@host`を開き、`http://127.0.0.1:18789/`を開きます。
- ゲートウェイホストに `gateway.auth.token` (または `OPENCLAW_GATEWAY_TOKEN` ) を設定します。
- Control UI 設定では、同じトークンを貼り付けます。
- まだ行き詰まっていますか？ `openclawステータス --all` を実行し、 [Troubleshooting](/gateway/troubleshooting) に従ってください。 認証の詳細については、 [Dashboard](/web/dashboard) を参照してください。

### gatewaybind tailnet を設定しましたが、何もリッスンをバインドできません。

`tailnet` は、ネットワークインターフェイス(100.64.0.0/10)からTailscale IPを選択します。 マシンが Tailscale (またはインターフェイスがダウンしている) 上にない場合、バインドするものは何もありません。

修正方法:

- Start Tailscale on that host (so it has a 100.x address), or
- `gateway.bind: "loopback"` / `"lan"` に切り替えます。

注意: `tailnet` は明示的です。 `auto` はループバックを好みます。`gateway.bind: "tailnet"`を使用します。

### 同じホストで複数のゲートウェイを実行できますか？

通常は - 1 つのゲートウェイで複数のメッセージングチャネルとエージェントを実行できます。 冗長性(レスキューボットなど)やハードアイソレーションが必要な場合にのみ、複数のゲートウェイを使用してください。

はい、しかし孤立させる必要があります：

- `OPENCLAW_CONFIG_PATH` (インスタンス毎の設定)
- `OPENCLAW_STATE_DIR` (インスタンス毎の状態)
- `agents.defaults.workspace` (ワークスペースの隔離)
- `gateway.port` (一意のポート)

クイックセットアップ(推奨):

- インスタンスごとに `openclaw--profile <name> …` を使用します (`~/.openclaw-<name>`).
- プロファイルの設定ごとに固有の `gateway.port` を設定します（手動で実行するには `--port` を渡します）。
- Install a per-profile service: `openclaw --profile <name> gateway install`.

プロファイルもサフィックスサービス名(`bot.mort.<profile>`; legacy `com.openclaw.*`, `openclaw-gateway-<profile>.service`, `OpenClawゲートウェイ (<profile>)`).
25. 完全ガイド: [複数ゲートウェイ](/gateway/multiple-gateways)。

### 無効なハンドシェイクコード1008が意味するもの

26. Gateway は **WebSocket サーバー** であり、最初のメッセージとして `connect` フレームを受け取ることを想定しています。 それ以外のものを受け取った場合は、接続
    を **code 1008** (ポリシー違反) で閉じます。

よくある原因:

- WSクライアントの代わりにブラウザ（`http://...`）で**HTTP** URLを開きました。
- 間違ったポートまたはパスを使用しました。
- プロキシまたはトンネルが認証ヘッダーを取り除いたり、ゲートウェイ以外のリクエストを送信しました。

クイックフィックス:

1. WSのURLを使用します: `wss://<host>:18789` (HTTPSの場合は`wss://...`)
2. 通常のブラウザタブでWSポートを開かないでください。
3. 認証がオンの場合は、トークン/パスワードを `connect` フレームに含めます。

CLIまたはTUIを使用している場合は、URLは次のようになります。

```
openclaw tui --url ws://<host>:18789 --token <token>
```

Protocol details: [Gateway protocol](/gateway/protocol).

## ログとデバッグ

### ログはどこにある

ファイルログ (構造化):

```
/tmp/openclaw/openclaw-YYYY-MM-DD.log
```

`logging.file` で安定したパスを設定できます。 ファイルログレベルは `logging.level` で制御されます。 コンソールの冗長性は `--verbose` と `logging.consoleLevel` で制御されます。

最速のログテール:

```bash
openclaw logs --follow
```

サービス/スーパーバイザログ(ゲートウェイが起動/システム経由で実行される場合):

- macOS: `$OPENCLAW_STATE_DIR/logs/gateway.log` と `gateway.err.log` (デフォルト: `~/.openclaw/logs/...`; プロファイルは `~/.openclaw-<profile>/logs/...`) を使用します。
- Linux: `journalctl --user -u openclaw-gateway[-<profile>].service -n 200 ---no-pager`
- Windows: `schtasks /Query /TN "OpenClawゲートウェイ (<profile>)" /V /FO LIST`

詳細は [Troubleshooting](/gateway/troubleshooting#log-locations) を参照してください。

### ゲートウェイサービスの再起動を停止する方法

ゲートウェイヘルパーを使用:

```bash
オープンクロウゲートウェイの状態
オープンクロウゲートウェイの再起動
```

手動でゲートウェイを実行する場合、 `openclawゲートウェイ --force` はポートを取り戻すことができます。 [Gateway](/gateway) を参照してください。

### OpenClawを再起動する方法は、Windows上で端末を閉じました。

**2つのWindowsインストールモード**があります:

**1) WSL2（推奨）:** ゲートウェイはLinux内で動作します。

PowerShell を開き、WSLと入力して再起動します。

```powershell
wsl
openclawゲートウェイステータス
openclawゲートウェイ再起動
```

サービスをインストールしていない場合は、フォアグラウンドで起動します。

```bash
openclaw gateway run
```

**2) Native Windows (お勧めしません):** GatewayはWindowsで直接動作します。

PowerShell を開いて実行:

```powershell
オープンクロウゲートウェイの状態
オープンクロウゲートウェイの再起動
```

手動で実行すると(サービスなし)、以下を使用します。

```powershell
openclaw gateway run
```

Docs: [Windows (WSL2)](/platforms/windows), [Gateway service runbook](/gateway).

### ゲートウェイは起動していますが、応答が届かない 何を確認すべきか

クイックヘルススイープから始めましょう：

```bash
openclaw status
openclaw models status
openclaw channels status
openclaw logs --follow
```

よくある原因:

- モデル認証が **ゲートウェイホスト** にロードされていません (`models status` を確認してください)。
- チャネルのペアリング/許可リストのブロック返信 (チャネル設定 + ログを確認してください)。
- WebChat/Dashboardは正しいトークンなしで開いています。

リモートの場合は、トンネル/テイルスケール接続が起動しており、
ゲートウェイWebSocketに到達可能であることを確認してください。

Docs: [Channels](/channels), [Troubleshooting](/gateway/troubleshooting), [リモートアクセス](/gateway/remote).

### ゲートウェイから切断された理由はありません

これは通常、UIがWebSocket接続を失ったことを意味します。 確認:

1. ゲートウェイは稼働していますか? `openclaw gateway status`
2. ゲートウェイは健全ですか? `openclaw status`
3. UIには正しいトークンがありますか？ `openclaw dashboard`
4. リモートの場合、トンネル/尾尺度は上にリンクされますか?

次にテールログ：

```bash
openclaw logs --follow
```

Docs: [Dashboard](/web/dashboard), [Remote access](/gateway/remote), [Troubleshooting](/gateway/troubleshooting).

### Telegram setMyCommands fails with network errors What should I be check

ログとチャネルの状態から開始:

```bash
openclawチャンネルステータス
openclawチャンネルログ --channel Telegram
```

VPSまたはプロキシの背後にいる場合は、アウトバウンドHTTPSが許可され、DNSが動作することを確認してください。
Gatewayがリモートの場合は、Gatewayホストのログを確認してください。

ドキュメント: [Telegram](/channels/telegram), format@@2チャンネルのトラブルシューティング](/channels/troubleshooting).

### TUIは出力を表示しません

最初にゲートウェイが到達可能で、エージェントが実行できることを確認します。

```bash
openclaw status
openclaw models status
openclaw logs --follow
```

TUIでは、`/status` を使用して現在の状態を確認します。 チャット
チャンネルに返信がある場合は、配信が有効になっていることを確認してください (`/delivery on`)。

Docs: [TUI](/web/tui), [Slash commands](/tools/slash-commands).

### 完全に停止し、ゲートウェイを起動する方法

サービスをインストールした場合:

```bash
openclaw gateway stop
openclaw gateway start
```

これは **監視されたサービス** (macOSで起動し、Linux でsystemd) を停止/起動します。
ゲートウェイがバックグラウンドでデーモンとして動作する場合に使用します。

フォアグラウンドで実行している場合は、Ctrl-C で停止します。

```bash
openclaw gateway run
```

Docs: [Gateway service runbook](/gateway).

### ELI5 openclawゲートウェイの再起動 vs openclawゲートウェイ

- `openclaw gateway restart`: **background service** (launchd/systemd) を再起動します。
- `openclaw gateway`: この端末セッションのゲートウェイを **前面**で実行します。

サービスをインストールした場合は、gateway コマンドを使用してください。
を1回オフにする場合は、前面で実行する場合は、`openclawゲートウェイ`を使用します。

### 何かが失敗したときに詳細を取得するための最速の方法は何ですか？

コンソールの詳細を取得するには、 `--verbose` でゲートウェイを起動します。 次に、チャネルのauth、モデルのルーティング、およびRPCエラーのログファイルを検査します。

## メディアと添付ファイル

### 私のスキルはimagePDFを生成しましたが、何も送信されませんでした。

エージェントからのアウトバウンド添付ファイルには、`MEDIA:<path-or-url>`行を含める必要があります（独自の行にあります）。 [OpenClawアシスタント設定](/start/openclaw) と [Agent send](/tools/agent-send) を参照してください。

CLI送信:

```bash
openclaw message send --target +1555550123 --message "Here you go" --media /path/to/file.png
```

また確認:

- ターゲットチャンネルはアウトバウンドメディアをサポートし、許可リストによってブロックされません。
- ファイルはプロバイダのサイズ制限内にあります(画像は最大2048ピクセルにリサイズされます)。

[Images](/nodes/images) を参照してください。

## セキュリティとアクセス制御

### OpenClawをインバウンドDMに公開しても安全ですか？

受信したDMを信頼できない入力として扱います。 デフォルトはリスクを軽減するように設計されています:

- DM対応チャンネルのデフォルトの動作は**ペアリング**です:
  - 不明な送信者はペアリングコードを受け取ります。ボットはメッセージを処理しません。
  - 承認: `openclawペアリング承認 <channel> <code>`
  - 保留中のリクエストは**3チャンネル**に上限されます。コードが届かない場合は、`openclawペアリングリスト <channel>` を確認してください。
- DMを開くには明示的なオプトインが必要です (`dmPolicy: "open"` と allowlist \`"\*")。

危険なDMポリシーを表面化するために、`openclaw医師`を実行してください。

### 迅速な注入はパブリックボットに対する懸念のみです

いいえ. 迅速な注入は**信頼できないコンテンツ**についてです。誰がボットをDMできるかだけではありません。
27. アシスタントが外部コンテンツ（ウェブ検索/取得、ブラウザページ、メール、ドキュメント、添付ファイル、貼り付けたログ）を読む場合、そのコンテンツにはモデルを乗っ取ろうとする指示が含まれている可能性があります。 これは、**あなたが唯一の送信者**であっても起こります。

最大のリスクは、ツールが有効になっている場合です。モデルを
に騙したり、あなたの代わりにツールを呼び出したりすることができます。 爆風の半径を以下によって減らす:

- 信頼できないコンテンツを要約するために読み取り専用またはツール無効化された「リーダ」エージェントを使用する
- ツール対応エージェントには、 `web_search` / `web_fetch` / `browser` をオフにします
- サンドボックス化と厳格なツールの許可リスト

詳細: [Security](/gateway/security).

### 自分のbotがGitHubアカウントまたは電話番号を持っている必要があります

はい、ほとんどのセットアップ用です。 ボットを別々の口座と電話番号で分離する
何か問題が発生した場合、爆発半径を減少させます。 これにより、個人アカウントに影響を与えることなく、
資格情報のローテーションやアクセスの取り消しが容易になります。

小さく始めなさい。 必要に応じて、あなたが実際に必要とするツールとアカウントのみにアクセスを許可し、あとで
を展開します。

ドキュメント: [Security](/gateway/security), [Pairing](/channels/pairing).

### 自分のテキストメッセージ上で自律性を与えることができますし、その安全性です

私たちはあなたの個人的なメッセージに対して完全な自律性をお勧めしません。 最も安全なパターンは:

- **ペアリングモード** または厳しい許可リストにDMを維持します。
- あなたに代わってメッセージを送りたい場合は、**別の番号またはアカウント**を使用してください。
- 下書きを許可し、**送信前に承認**

あなたが実験したい場合は、専用のアカウントでそれを行い、それを分離したままにしてください。
[Security](/gateway/security) を参照してください。

### パーソナルアシスタントに安価なモデルを使用できますか？

はい、エージェントがチャットのみで入力が信頼されている場合は**もし**。 より小さい階層は
命令ハイジャックの影響を受けやすいので、ツール対応エージェント
や信頼できないコンテンツを読むときは避けてください。 より小さいモデルを使用する必要がある場合は、
ツールをロックし、サンドボックス内で実行します。 [Security](/gateway/security) を参照してください。

### 僅用於中文

ペアリングコードは、Botと
`dmPolicy: "pairing"が有効な場合、**のみ**送信されます。 `/start\` 自体はコードを生成しません。

保留中のリクエストを確認:

```bash
openclaw pairing list telegram
```

即座にアクセスしたい場合は、送信者IDを許可するか、アカウントに`dmPolicy: "open"`
を設定してください。

### WhatsAppは私の連絡先にメッセージを表示します ペアリングはどのように動作します

いいえ. デフォルトのWhatsAppDMポリシーは**ペアリング**です。 不明な送信者はペアリングコードのみを取得し、そのメッセージは**処理されません**。 OpenClawは、受信したチャットまたはトリガーを明示的に送信するチャットに対してのみ返信します。

ペアリングを承認:

```bash
28. openclaw pairing approve whatsapp <code>
```

保留中のリクエスト一覧:

```bash
openclaw pairing list whatsapp
```

ウィザードの電話番号プロンプト：あなた自身のDMが許可されるように**許可リスト/所有者**を設定するために使用されます。 自動送信には使用されません。 あなたのWhatsApp番号で実行する場合は、その番号を使用し、`channels.whatselfChatMode` を有効にしてください。

## チャットコマンド、タスクを中断し、"それは止まらない"

### 内部システムメッセージのチャット表示を停止するにはどうすればいいですか？

ほとんどの内部またはツールメッセージは、セッションの**verbose**または**reasoning**が
有効な場合にのみ表示されます。

表示されているチャットを修正します。

```
/verbose off
/reasoning off
```

それでも騒々しい場合は、Control UI のセッション設定を確認し、verbose
を **継承** に設定してください。 また、`verboseDefault`が設定されているボットプロファイルを使用していないことを確認します。設定で
を`on`に設定します。

Docs: [Thinking and verbose](/tools/thinking), [Security](/gateway/security#reasoning--verbose-output-in-groups).

### 実行中のタスクをキャンセルするにはどうすればいいですか？

これらのいずれかを **スタンドアロンメッセージ** (スラッシュなし) で送信します:

```

停止
esc
wait
exit
interrupt
```

これらはアボートトリガーです(スラッシュコマンドではありません)。

バックグラウンドプロセス(exec ツールから)の場合は、エージェントに次の操作を依頼できます。

```
プロセス アクション:kill sessionId:XXX
```

29. スラッシュコマンドの概要: [スラッシュコマンド](/tools/slash-commands)を参照してください。

ほとんどのコマンドは、`/`で始まる**スタンドアロン**メッセージとして送信する必要がありますが、いくつかのショートカット(`/status`のような)も許可リストに載った送信者に対してインラインで動作します。

### Telegram クロスコンテクストからDiscordメッセージを送信するにはどうすればいいですか？

OpenClawはデフォルトで**クロスプロバイダー**メッセージングをブロックします。 30. ツール呼び出しが Telegram にバインドされている場合、明示的に許可しない限り Discord には送信されません。

エージェントのクロスプロバイダー メッセージを有効にします。

```json5
31. {
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

設定を編集した後、ゲートウェイを再起動します。 単一の
エージェントのみにこれを設定したい場合は、代わりに `agents.list[].tools.message` に設定してください。

### なぜボットが迅速なメッセージを無視しているのか？

format@@0モードでは、飛行中の実行と新しいメッセージがどのように相互作用するかを制御します。 モードを変更するには `/queue` を使用します。

- `steer` - 新しいメッセージは現在のタスクをリダイレクトします
- `followup` - 一度に1つのメッセージを実行する
- `collect` - 一括送金と返信（デフォルト）
- `steer-backlog` - ステアリングしてバックログを処理する
- `interrupt` - 現在の実行を中止して新たに開始する

フォローアップモードには `debounce:2s cap:25 drop:summarize` のようなオプションを追加できます。

## スクリーンショット/チャットログから正確な質問に答えます

**Q: 「APIキーを使用したAnthropicのデフォルトモデルは何ですか？」**

**A:** OpenClawでは、資格情報とモデル選択は分離されています。 `ANTHROPIC_API_KEY` (または認証プロファイルにAnthropic APIキーを保存する) を設定すると認証が有効になりますが、実際のデフォルトモデルは `agents. efaults.model.primary（例：`anthropic/claude-sonnet-4-5`または`anthropic/claude-opus-4-6`） プロファイル"anthropic:default"に認証情報が見つからない場合は、ゲートウェイが期待される `auth-profilesにAnthropic資格情報を見つけることができなかったことを意味します。 実行しているエージェントの息子。

---

まだ行き詰まっていますか？ [Discord](https://discord.com/invite/clawd) で質問するか、[GitHub discussion](https://github.com/openclaw/openclaw/discussions) を開きます。
