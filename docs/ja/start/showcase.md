---
title: "ショーケース"
description: "Real-world OpenClaw projects from the community"
summary: "OpenClaw によって実現された、コミュニティ構築のプロジェクトとインテグレーション"
x-i18n:
  source_path: start/showcase.md
  source_hash: b3460f6a7b994879
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:23:52Z
---

# ショーケース

コミュニティによる実際のプロジェクトです。OpenClaw で人々が何を構築しているのかをご覧ください。

<Info>
**掲載されたいですか？** プロジェクトを [Discord の #showcase](https://discord.gg/clawd) で共有するか、[X で @openclaw をタグ付け](https://x.com/openclaw) してください。
</Info>

## 🎥 OpenClaw の実例

VelvetShark によるフルセットアップ解説（28 分）。

<div
  style={{
    position: "relative",
    paddingBottom: "56.25%",
    height: 0,
    overflow: "hidden",
    borderRadius: 16,
  }}
>
  <iframe
    src="https://www.youtube-nocookie.com/embed/SaWSPZoPX34"
    title="OpenClaw: The self-hosted AI that Siri should have been (Full setup)"
    style={{ position: "absolute", top: 0, left: 0, width: "100%", height: "100%" }}
    frameBorder="0"
    loading="lazy"
    allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
    allowFullScreen
  />
</div>

[YouTube で視聴](https://www.youtube.com/watch?v=SaWSPZoPX34)

<div
  style={{
    position: "relative",
    paddingBottom: "56.25%",
    height: 0,
    overflow: "hidden",
    borderRadius: 16,
  }}
>
  <iframe
    src="https://www.youtube-nocookie.com/embed/mMSKQvlmFuQ"
    title="OpenClaw showcase video"
    style={{ position: "absolute", top: 0, left: 0, width: "100%", height: "100%" }}
    frameBorder="0"
    loading="lazy"
    allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
    allowFullScreen
  />
</div>

[YouTube で視聴](https://www.youtube.com/watch?v=mMSKQvlmFuQ)

<div
  style={{
    position: "relative",
    paddingBottom: "56.25%",
    height: 0,
    overflow: "hidden",
    borderRadius: 16,
  }}
>
  <iframe
    src="https://www.youtube-nocookie.com/embed/5kkIJNUGFho"
    title="OpenClaw community showcase"
    style={{ position: "absolute", top: 0, left: 0, width: "100%", height: "100%" }}
    frameBorder="0"
    loading="lazy"
    allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
    allowFullScreen
  />
</div>

[YouTube で視聴](https://www.youtube.com/watch?v=5kkIJNUGFho)

## 🆕 Discord からの最新情報

<CardGroup cols={2}>

<Card title="PR レビュー → Telegram フィードバック" icon="code-pull-request" href="https://x.com/i/status/2010878524543131691">
  **@bangnokia** • `review` `github` `telegram`

OpenCode が変更を完了 → PR を作成 → OpenClaw が差分をレビューし、「軽微な提案」と明確なマージ判断（先に適用すべき重要修正を含む）を Telegram で返信します。

  <img src="/assets/showcase/pr-review-telegram.jpg" alt="OpenClaw PR review feedback delivered in Telegram" />
</Card>

<Card title="数分で作るワインセラー Skill" icon="wine-glass" href="https://x.com/i/status/2010916352454791216">
  **@prades_maxime** • `skills` `local` `csv`

ローカルのワインセラー Skill を「Robby」（@openclaw）に依頼。サンプルの CSV エクスポートと保存場所を尋ね、Skill を迅速に構築・テストします（例では 962 本）。

  <img src="/assets/showcase/wine-cellar-skill.jpg" alt="OpenClaw building a local wine cellar skill from CSV" />
</Card>

<Card title="Tesco ショップ自動操縦" icon="cart-shopping" href="https://x.com/i/status/2009724862470689131">
  **@marchattonhere** • `automation` `browser` `shopping`

週間の食事計画 → 定番商品 → 配送枠の予約 → 注文確定。API は不要、ブラウザ操作のみです。

  <img src="/assets/showcase/tesco-shop.jpg" alt="Tesco shop automation via chat" />
</Card>

<Card title="SNAG スクリーンショットから Markdown へ" icon="scissors" href="https://github.com/am-will/snag">
  **@am-will** • `devtools` `screenshots` `markdown`

画面領域をホットキーで選択 → Gemini Vision → 即座にクリップボードへ Markdown。

  <img src="/assets/showcase/snag.png" alt="SNAG screenshot-to-markdown tool" />
</Card>

<Card title="Agents UI" icon="window-maximize" href="https://releaseflow.net/kitze/agents-ui">
  **@kitze** • `ui` `skills` `sync`

Agents、Claude、Codex、OpenClaw 全体で Skills／コマンドを管理するデスクトップアプリ。

  <img src="/assets/showcase/agents-ui.jpg" alt="Agents UI app" />
</Card>

<Card title="Telegram 音声メモ（papla.media）" icon="microphone" href="https://papla.media/docs">
  **Community** • `voice` `tts` `telegram`

papla.media の TTS をラップし、結果を Telegram の音声メモとして送信します（煩わしい自動再生なし）。

  <img src="/assets/showcase/papla-tts.jpg" alt="Telegram voice note output from TTS" />
</Card>

<Card title="CodexMonitor" icon="eye" href="https://clawhub.com/odrobnik/codexmonitor">
  **@odrobnik** • `devtools` `codex` `brew`

Homebrew でインストールするヘルパー。ローカルの OpenAI Codex セッションを一覧表示／検査／監視（CLI + VS Code）。

  <img src="/assets/showcase/codexmonitor.png" alt="CodexMonitor on ClawHub" />
</Card>

<Card title="Bambu 3D プリンター制御" icon="print" href="https://clawhub.com/tobiasbischoff/bambu-cli">
  **@tobiasbischoff** • `hardware` `3d-printing` `skill`

BambuLab プリンターを制御・トラブルシュート：ステータス、ジョブ、カメラ、AMS、キャリブレーションなど。

  <img src="/assets/showcase/bambu-cli.png" alt="Bambu CLI skill on ClawHub" />
</Card>

<Card title="ウィーン交通（Wiener Linien）" icon="train" href="https://clawhub.com/hjanuschka/wienerlinien">
  **@hjanuschka** • `travel` `transport` `skill`

ウィーン公共交通のリアルタイム出発情報、障害、エレベーター状況、経路案内。

  <img src="/assets/showcase/wienerlinien.png" alt="Wiener Linien skill on ClawHub" />
</Card>

<Card title="ParentPay 学校給食" icon="utensils" href="#">
  **@George5562** • `automation` `browser` `parenting`

ParentPay を使った英国の学校給食予約を自動化。確実なセルクリックのためにマウス座標を使用します。
</Card>

<Card title="R2 アップロード（Send Me My Files）" icon="cloud-arrow-up" href="https://clawhub.com/skills/r2-upload">
  **@julianengel** • `files` `r2` `presigned-urls`

Cloudflare R2／S3 にアップロードし、安全な事前署名付きダウンロードリンクを生成。リモートの OpenClaw インスタンスに最適です。
</Card>

<Card title="Telegram 経由の iOS アプリ" icon="mobile" href="#">
  **@coard** • `ios` `xcode` `testflight`

地図と音声録音を備えた完全な iOS アプリを構築し、Telegram チャットだけで TestFlight にデプロイしました。

  <img src="/assets/showcase/ios-testflight.jpg" alt="iOS app on TestFlight" />
</Card>

<Card title="Oura Ring ヘルスアシスタント" icon="heart-pulse" href="#">
  **@AS** • `health` `oura` `calendar`

Oura ring のデータをカレンダー、予定、ジムのスケジュールと統合する個人向け AI ヘルスアシスタント。

  <img src="/assets/showcase/oura-health.png" alt="Oura ring health assistant" />
</Card>
<Card title="Kev のドリームチーム（14 以上の Agents）" icon="robot" href="https://github.com/adam91holt/orchestrated-ai-articles">
  **@adam91holt** • `multi-agent` `orchestration` `architecture` `manifesto`

1 つの ゲートウェイ 配下に 14 以上の Agents。Opus 4.5 オーケストレーターが Codex ワーカーへ委譲します。ドリームチームの構成、モデル選定、サンドボックス化、Webhook、ハートビート、委譲フローを網羅した包括的な [技術解説](https://github.com/adam91holt/orchestrated-ai-articles)。エージェントのサンドボックス化には [Clawdspace](https://github.com/adam91holt/clawdspace)。[ブログ記事](https://adams-ai-journey.ghost.io/2026-the-year-of-the-orchestrator/)。
</Card>

<Card title="Linear CLI" icon="terminal" href="https://github.com/Finesssee/linear-cli">
  **@NessZerra** • `devtools` `linear` `cli` `issues`

エージェント指向ワークフロー（Claude Code、OpenClaw）と統合する Linear 用 CLI。ターミナルから課題、プロジェクト、ワークフローを管理。初の外部 PR がマージされました！
</Card>

<Card title="Beeper CLI" icon="message" href="https://github.com/blqke/beepcli">
  **@jules** • `messaging` `beeper` `cli` `automation`

Beeper Desktop 経由でメッセージの閲覧、送信、アーカイブ。Beeper の local MCP API を使用し、エージェントが iMessage、WhatsApp などすべてのチャットを一元管理できます。
</Card>

</CardGroup>

## 🤖 自動化とワークフロー

<CardGroup cols={2}>

<Card title="Winix 空気清浄機制御" icon="wind" href="https://x.com/antonplex/status/2010518442471006253">
  **@antonplex** • `automation` `hardware` `air-quality`

Claude Code が清浄機の操作を発見・確認し、その後 OpenClaw が室内の空気品質管理を引き継ぎます。

  <img src="/assets/showcase/winix-air-purifier.jpg" alt="Winix air purifier control via OpenClaw" />
</Card>

<Card title="美しい空のカメラショット" icon="camera" href="https://x.com/signalgaining/status/2010523120604746151">
  **@signalgaining** • `automation` `camera` `skill` `images`

屋根のカメラをトリガーに、「空がきれいなときに撮影して」と OpenClaw に依頼。Skill を設計し、撮影まで行いました。

  <img src="/assets/showcase/roof-camera-sky.jpg" alt="Roof camera sky snapshot captured by OpenClaw" />
</Card>

<Card title="ビジュアルな朝のブリーフィングシーン" icon="robot" href="https://x.com/buddyhadry/status/2010005331925954739">
  **@buddyhadry** • `automation` `briefing` `images` `telegram`

スケジュールされたプロンプトにより、毎朝 1 枚の「シーン」画像（天気、タスク、日付、お気に入りの投稿／引用）を OpenClaw のペルソナ経由で生成します。
</Card>

<Card title="パデルコート予約" icon="calendar-check" href="https://github.com/joshp123/padel-cli">
  **@joshp123** • `automation` `booking` `cli`
  
  Playtomic の空き状況チェッカー＋予約 CLI。空きコートを二度と逃しません。
  
  <img src="/assets/showcase/padel-screenshot.jpg" alt="padel-cli screenshot" />
</Card>

<Card title="会計インテーク" icon="file-invoice-dollar">
  **Community** • `automation` `email` `pdf`
  
  メールから PDF を収集し、税理士向けに書類を準備。月次会計を自動化します。
</Card>

<Card title="カウチポテト開発モード" icon="couch" href="https://davekiss.com">
  **@davekiss** • `telegram` `website` `migration` `astro`

Netflix を見ながら Telegram 経由で個人サイトを全面再構築。Notion → Astro、18 記事を移行、DNS を Cloudflare へ。ノート PC を一度も開きませんでした。
</Card>

<Card title="求人検索エージェント" icon="briefcase">
  **@attol8** • `automation` `api` `skill`

求人情報を検索し、CV のキーワードと照合して、関連性の高い機会をリンク付きで返します。JSearch API を使い 30 分で構築。
</Card>

<Card title="Jira Skill ビルダー" icon="diagram-project" href="https://x.com/jdrhyne/status/2008336434827002232">
  **@jdrhyne** • `automation` `jira` `skill` `devtools`

OpenClaw を Jira に接続し、ClawHub に存在する前にその場で新しい Skill を生成しました。
</Card>

<Card title="Telegram 経由の Todoist Skill" icon="list-check" href="https://x.com/iamsubhrajyoti/status/2009949389884920153">
  **@iamsubhrajyoti** • `automation` `todoist` `skill` `telegram`

Todoist のタスクを自動化し、Telegram チャット内で OpenClaw に Skill を直接生成させました。
</Card>

<Card title="TradingView 分析" icon="chart-line">
  **@bheem1798** • `finance` `browser` `automation`

ブラウザ自動化で TradingView にログインし、チャートをスクリーンショット、必要に応じてテクニカル分析を実行。API は不要で、ブラウザ操作のみです。
</Card>

<Card title="Slack 自動サポート" icon="slack">
  **@henrymascot** • `slack` `automation` `support`

社内の Slack チャンネルを監視して有用な回答を返し、通知を Telegram に転送。依頼されることなく、本番環境のバグを自律的に修正しました。
</Card>

</CardGroup>

## 🧠 ナレッジとメモリ

<CardGroup cols={2}>

<Card title="xuezh 中国語学習" icon="language" href="https://github.com/joshp123/xuezh">
  **@joshp123** • `learning` `voice` `skill`
  
  OpenClaw 経由で、発音フィードバックと学習フローを備えた中国語学習エンジン。
  
  <img src="/assets/showcase/xuezh-pronunciation.jpeg" alt="xuezh pronunciation feedback" />
</Card>

<Card title="WhatsApp メモリボールト" icon="vault">
  **Community** • `memory` `transcription` `indexing`
  
  WhatsApp の完全なエクスポートを取り込み、1,000 以上の音声メモを文字起こしし、git ログと突合。リンク付きの Markdown レポートを出力します。
</Card>

<Card title="Karakeep セマンティック検索" icon="magnifying-glass" href="https://github.com/jamesbrooksco/karakeep-semantic-search">
  **@jamesbrooksco** • `search` `vector` `bookmarks`
  
  Qdrant と OpenAI／Ollama の埋め込みを使い、Karakeep ブックマークにベクトル検索を追加します。
</Card>

<Card title="Inside-Out-2 メモリ" icon="brain">
  **Community** • `memory` `beliefs` `self-model`
  
  セッションファイルをメモリ → 信念 → 進化する自己モデルへと変換する、独立したメモリマネージャー。
</Card>

</CardGroup>

## 🎙️ 音声と電話

<CardGroup cols={2}>

<Card title="Clawdia 電話ブリッジ" icon="phone" href="https://github.com/alejandroOPI/clawdia-bridge">
  **@alejandroOPI** • `voice` `vapi` `bridge`
  
  Vapi 音声アシスタント ↔ OpenClaw HTTP ブリッジ。エージェントとのほぼリアルタイムな通話を実現します。
</Card>

<Card title="OpenRouter 文字起こし" icon="microphone" href="https://clawhub.com/obviyus/openrouter-transcribe">
  **@obviyus** • `transcription` `multilingual` `skill`

OpenRouter（Gemini など）経由の多言語音声文字起こし。ClawHub で利用可能です。
</Card>

</CardGroup>

## 🏗️ インフラとデプロイ

<CardGroup cols={2}>

<Card title="Home Assistant アドオン" icon="home" href="https://github.com/ngutman/openclaw-ha-addon">
  **@ngutman** • `homeassistant` `docker` `raspberry-pi`
  
  SSH トンネル対応と永続状態を備えた、Home Assistant OS 上で動作する OpenClaw ゲートウェイ。
</Card>

<Card title="Home Assistant Skill" icon="toggle-on" href="https://clawhub.com/skills/homeassistant">
  **ClawHub** • `homeassistant` `skill` `automation`
  
  自然言語で Home Assistant デバイスを制御・自動化します。
</Card>

<Card title="Nix パッケージング" icon="snowflake" href="https://github.com/openclaw/nix-openclaw">
  **@openclaw** • `nix` `packaging` `deployment`
  
  再現性のあるデプロイのための、バッテリー同梱の nix 化された OpenClaw 設定。
</Card>

<Card title="CalDAV カレンダー" icon="calendar" href="https://clawhub.com/skills/caldav-calendar">
  **ClawHub** • `calendar` `caldav` `skill`
  
  khal／vdirsyncer を使用するカレンダー Skill。セルフホストのカレンダー連携です。
</Card>

</CardGroup>

## 🏠 ホームとハードウェア

<CardGroup cols={2}>

<Card title="GoHome 自動化" icon="house-signal" href="https://github.com/joshp123/gohome">
  **@joshp123** • `home` `nix` `grafana`
  
  インターフェースとして OpenClaw を使用する Nix ネイティブのホーム自動化。美しい Grafana ダッシュボードも備えます。
  
  <img src="/assets/showcase/gohome-grafana.png" alt="GoHome Grafana dashboard" />
</Card>

<Card title="Roborock 掃除機" icon="robot" href="https://github.com/joshp123/gohome/tree/main/plugins/roborock">
  **@joshp123** • `vacuum` `iot` `plugin`
  
  自然な会話で Roborock ロボット掃除機を操作します。
  
  <img src="/assets/showcase/roborock-screenshot.jpg" alt="Roborock status" />
</Card>

</CardGroup>

## 🌟 コミュニティプロジェクト

<CardGroup cols={2}>

<Card title="StarSwap マーケットプレイス" icon="star" href="https://star-swap.com/">
  **Community** • `marketplace` `astronomy` `webapp`
  
  天文機材のフルマーケットプレイス。OpenClaw エコシステムと共に／周辺で構築されています。
</Card>

</CardGroup>

---

## プロジェクトを投稿する

共有したいものがありますか？ぜひご紹介させてください。

<Steps>
  <Step title="共有する">
    [Discord の #showcase](https://discord.gg/clawd) に投稿するか、[X で @openclaw にツイート](https://x.com/openclaw) してください。
  </Step>
  <Step title="詳細を含める">
    何をするものか、リポジトリ／デモへのリンク、可能であればスクリーンショットを共有してください。
  </Step>
  <Step title="掲載">
    目立つプロジェクトをこのページに追加します。
  </Step>
</Steps>
