---
read_when:
    - OpenClawの実際の使用例を探している
    - コミュニティプロジェクトのハイライトを更新する
summary: OpenClawを活用したコミュニティ製プロジェクトとインテグレーション
title: ショーケース
x-i18n:
    generated_at: "2026-04-02T08:40:01Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: f4f4693de70c39365c89f67467a9a5f580781b3adc4818e1e10738f9ebf98d58
    source_path: start/showcase.md
    workflow: 15
---

# ショーケース

コミュニティによる実際のプロジェクト。OpenClawで何が作られているかご覧ください。

<Info>
**掲載されたいですか？** [Discord の #self-promotion](https://discord.gg/clawd) でプロジェクトを共有するか、[X で @openclaw にタグ付け](https://x.com/openclaw)してください。
</Info>

## 🎥 OpenClaw の実演

VelvetShark によるフルセットアップウォークスルー（28分）。

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

OpenCode が変更を完了 → PR をオープン → OpenClaw が diff をレビューし、Telegram に「軽微な提案」と明確なマージ判定（先に適用すべき重要な修正を含む）を返信します。

  <img src="/assets/showcase/pr-review-telegram.jpg" alt="OpenClaw の PR レビューフィードバックが Telegram に配信される様子" />
</Card>

<Card title="数分でワインセラー Skill を構築" icon="wine-glass" href="https://x.com/i/status/2010916352454791216">
  **@prades_maxime** • `skills` `local` `csv`

「Robby」（@openclaw）にローカルのワインセラー Skill を依頼。サンプル CSV エクスポートと保存先を要求した後、Skill を素早くビルド・テスト（例では962本のワイン）。

  <img src="/assets/showcase/wine-cellar-skill.jpg" alt="OpenClaw が CSV からローカルワインセラー Skill を構築する様子" />
</Card>

<Card title="Tesco ショッピングオートパイロット" icon="cart-shopping" href="https://x.com/i/status/2009724862470689131">
  **@marchattonhere** • `automation` `browser` `shopping`

週間献立 → いつもの商品 → 配達スロット予約 → 注文確定。API不要、ブラウザ操作だけで完結。

  <img src="/assets/showcase/tesco-shop.jpg" alt="チャット経由の Tesco ショッピング自動化" />
</Card>

<Card title="SNAG スクリーンショットから Markdown へ" icon="scissors" href="https://github.com/am-will/snag">
  **@am-will** • `devtools` `screenshots` `markdown`

ホットキーで画面領域を選択 → Gemini ビジョン → クリップボードに即座に Markdown が生成。

  <img src="/assets/showcase/snag.png" alt="SNAG スクリーンショットから Markdown への変換ツール" />
</Card>

<Card title="Agents UI" icon="window-maximize" href="https://releaseflow.net/kitze/agents-ui">
  **@kitze** • `ui` `skills` `sync`

Agents、Claude、Codex、OpenClaw にまたがる Skills やコマンドを管理するデスクトップアプリ。

  <img src="/assets/showcase/agents-ui.jpg" alt="Agents UI アプリ" />
</Card>

<Card title="Telegram ボイスノート（papla.media）" icon="microphone" href="https://papla.media/docs">
  **コミュニティ** • `voice` `tts` `telegram`

papla.media の TTS をラップし、結果を Telegram ボイスノートとして送信（煩わしい自動再生なし）。

  <img src="/assets/showcase/papla-tts.jpg" alt="TTS からの Telegram ボイスノート出力" />
</Card>

<Card title="CodexMonitor" icon="eye" href="https://clawhub.com/odrobnik/codexmonitor">
  **@odrobnik** • `devtools` `codex` `brew`

Homebrew でインストール可能な、ローカルの OpenAI Codex セッションを一覧・検査・監視するヘルパー（CLI + VS Code）。

  <img src="/assets/showcase/codexmonitor.png" alt="ClawHub 上の CodexMonitor" />
</Card>

<Card title="Bambu 3D プリンター制御" icon="print" href="https://clawhub.com/tobiasbischoff/bambu-cli">
  **@tobiasbischoff** • `hardware` `3d-printing` `skill`

BambuLab プリンターの制御とトラブルシューティング：ステータス、ジョブ、カメラ、AMS、キャリブレーションなど。

  <img src="/assets/showcase/bambu-cli.png" alt="ClawHub 上の Bambu CLI Skill" />
</Card>

<Card title="ウィーン交通（Wiener Linien）" icon="train" href="https://clawhub.com/hjanuschka/wienerlinien">
  **@hjanuschka** • `travel` `transport` `skill`

ウィーンの公共交通機関のリアルタイム出発情報、運行障害、エレベーター状況、ルート案内。

  <img src="/assets/showcase/wienerlinien.png" alt="ClawHub 上の Wiener Linien Skill" />
</Card>

<Card title="ParentPay 学校給食" icon="utensils" href="#">
  **@George5562** • `automation` `browser` `parenting`

ParentPay 経由の英国学校給食予約を自動化。マウス座標を使用してテーブルセルを確実にクリック。
</Card>

<Card title="R2 アップロード（Send Me My Files）" icon="cloud-arrow-up" href="https://clawhub.com/skills/r2-upload">
  **@julianengel** • `files` `r2` `presigned-urls`

Cloudflare R2/S3 にアップロードし、安全な署名付きダウンロードリンクを生成。リモートの OpenClaw インスタンスに最適。
</Card>

<Card title="Telegram 経由の iOS アプリ" icon="mobile" href="#">
  **@coard** • `ios` `xcode` `testflight`

マップと音声録音機能を備えた完全な iOS アプリを構築し、すべて Telegram チャット経由で TestFlight にデプロイ。

  <img src="/assets/showcase/ios-testflight.jpg" alt="TestFlight 上の iOS アプリ" />
</Card>

<Card title="Oura Ring ヘルスアシスタント" icon="heart-pulse" href="#">
  **@AS** • `health` `oura` `calendar`

Oura リングのデータをカレンダー、予約、ジムスケジュールと統合するパーソナル AI ヘルスアシスタント。

  <img src="/assets/showcase/oura-health.png" alt="Oura リング ヘルスアシスタント" />
</Card>
<Card title="Kev のドリームチーム（14以上のエージェント）" icon="robot" href="https://github.com/adam91holt/orchestrated-ai-articles">
  **@adam91holt** • `multi-agent` `orchestration` `architecture` `manifesto`

1つの Gateway ゲートウェイ配下に14以上のエージェントを配置し、Opus 4.5 オーケストレーターが Codex ワーカーに委任。ドリームチームの構成、モデル選択、サンドボックス化、Webhook、ハートビート、委任フローを網羅する包括的な[技術解説](https://github.com/adam91holt/orchestrated-ai-articles)。エージェントのサンドボックス化には [Clawdspace](https://github.com/adam91holt/clawdspace)。[ブログ記事](https://adams-ai-journey.ghost.io/2026-the-year-of-the-orchestrator/)。
</Card>

<Card title="Linear CLI" icon="terminal" href="https://github.com/Finesssee/linear-cli">
  **@NessZerra** • `devtools` `linear` `cli` `issues`

エージェントワークフロー（Claude Code、OpenClaw）と統合する Linear 用 CLI。ターミナルからイシュー、プロジェクト、ワークフローを管理。初の外部 PR がマージ済み！
</Card>

<Card title="Beeper CLI" icon="message" href="https://github.com/blqke/beepcli">
  **@jules** • `messaging` `beeper` `cli` `automation`

Beeper Desktop 経由でメッセージの閲覧、送信、アーカイブ。Beeper ローカル MCP API を使用し、エージェントがすべてのチャット（iMessage、WhatsApp など）を一元管理。
</Card>

</CardGroup>

## 🤖 自動化とワークフロー

<CardGroup cols={2}>

<Card title="Winix 空気清浄機制御" icon="wind" href="https://x.com/antonplex/status/2010518442471006253">
  **@antonplex** • `automation` `hardware` `air-quality`

Claude Code が清浄機の制御方法を発見・確認し、その後 OpenClaw が部屋の空気品質管理を引き継ぎます。

  <img src="/assets/showcase/winix-air-purifier.jpg" alt="OpenClaw による Winix 空気清浄機制御" />
</Card>

<Card title="きれいな空のカメラショット" icon="camera" href="https://x.com/signalgaining/status/2010523120604746151">
  **@signalgaining** • `automation` `camera` `skill` `images`

屋上カメラがトリガー：空がきれいに見えるたびに OpenClaw に写真撮影を依頼 — Skill を設計してシャッターを切りました。

  <img src="/assets/showcase/roof-camera-sky.jpg" alt="OpenClaw が撮影した屋上カメラの空のスナップショット" />
</Card>

<Card title="ビジュアルモーニングブリーフィングシーン" icon="robot" href="https://x.com/buddyhadry/status/2010005331925954739">
  **@buddyhadry** • `automation` `briefing` `images` `telegram`

スケジュールされたプロンプトが毎朝1枚の「シーン」画像を生成（天気、タスク、日付、お気に入りの投稿/引用）。OpenClaw のペルソナを使用。
</Card>

<Card title="パデルコート予約" icon="calendar-check" href="https://github.com/joshp123/padel-cli">
  **@joshp123** • `automation` `booking` `cli`
  
  Playtomic の空き状況チェック + 予約 CLI。空きコートをもう見逃しません。
  
  <img src="/assets/showcase/padel-screenshot.jpg" alt="padel-cli のスクリーンショット" />
</Card>

<Card title="会計書類の取り込み" icon="file-invoice-dollar">
  **コミュニティ** • `automation` `email` `pdf`
  
  メールから PDF を収集し、税理士向けの書類を準備。月次会計をオートパイロットで。
</Card>

<Card title="カウチポテト開発モード" icon="couch" href="https://davekiss.com">
  **@davekiss** • `telegram` `website` `migration` `astro`

Netflix を見ながら Telegram 経由で個人サイトを完全リビルド — Notion → Astro、18記事を移行、DNS を Cloudflare に変更。ノートパソコンを一度も開かず。
</Card>

<Card title="求人検索エージェント" icon="briefcase">
  **@attol8** • `automation` `api` `skill`

求人情報を検索し、履歴書のキーワードとマッチングし、リンク付きの関連求人を返します。JSearch API を使用して30分で構築。
</Card>

<Card title="Jira Skill ビルダー" icon="diagram-project" href="https://x.com/jdrhyne/status/2008336434827002232">
  **@jdrhyne** • `automation` `jira` `skill` `devtools`

OpenClaw が Jira に接続し、新しい Skill をその場で生成（ClawHub に存在する前に）。
</Card>

<Card title="Telegram 経由の Todoist Skill" icon="list-check" href="https://x.com/iamsubhrajyoti/status/2009949389884920153">
  **@iamsubhrajyoti** • `automation` `todoist` `skill` `telegram`

Todoist タスクを自動化し、OpenClaw に Telegram チャット内で直接 Skill を生成させました。
</Card>

<Card title="TradingView 分析" icon="chart-line">
  **@bheem1798** • `finance` `browser` `automation`

ブラウザ自動化で TradingView にログインし、チャートをスクリーンショットし、オンデマンドでテクニカル分析を実行。API 不要 — ブラウザ操作のみ。
</Card>

<Card title="Slack 自動サポート" icon="slack">
  **@henrymascot** • `slack` `automation` `support`

社内 Slack チャネルを監視し、的確に応答し、通知を Telegram に転送。デプロイ済みアプリの本番バグを依頼なしに自律的に修正。
</Card>

</CardGroup>

## 🧠 知識とメモリ

<CardGroup cols={2}>

<Card title="xuezh 中国語学習" icon="language" href="https://github.com/joshp123/xuezh">
  **@joshp123** • `learning` `voice` `skill`
  
  発音フィードバックと学習フローを備えた、OpenClaw 経由の中国語学習エンジン。
  
  <img src="/assets/showcase/xuezh-pronunciation.jpeg" alt="xuezh の発音フィードバック" />
</Card>

<Card title="WhatsApp メモリーボールト" icon="vault">
  **コミュニティ** • `memory` `transcription` `indexing`
  
  WhatsApp の完全なエクスポートを取り込み、1,000件以上のボイスノートを文字起こしし、git ログとクロスチェックし、リンク付き Markdown レポートを出力。
</Card>

<Card title="Karakeep セマンティック検索" icon="magnifying-glass" href="https://github.com/jamesbrooksco/karakeep-semantic-search">
  **@jamesbrooksco** • `search` `vector` `bookmarks`
  
  Qdrant + OpenAI/Ollama エンベディングを使用して Karakeep ブックマークにベクトル検索を追加。
</Card>

<Card title="Inside-Out-2 メモリー" icon="brain">
  **コミュニティ** • `memory` `beliefs` `self-model`
  
  セッションファイルを記憶 → 信念 → 進化する自己モデルに変換する独立したメモリマネージャー。
</Card>

</CardGroup>

## 🎙️ 音声と電話

<CardGroup cols={2}>

<Card title="Clawdia 電話ブリッジ" icon="phone" href="https://github.com/alejandroOPI/clawdia-bridge">
  **@alejandroOPI** • `voice` `vapi` `bridge`
  
  Vapi 音声アシスタント ↔ OpenClaw HTTP ブリッジ。エージェントとほぼリアルタイムで電話通話。
</Card>

<Card title="OpenRouter 文字起こし" icon="microphone" href="https://clawhub.com/obviyus/openrouter-transcribe">
  **@obviyus** • `transcription` `multilingual` `skill`

OpenRouter（Gemini など）経由の多言語音声文字起こし。ClawHub で入手可能。
</Card>

</CardGroup>

## 🏗️ インフラとデプロイ

<CardGroup cols={2}>

<Card title="Home Assistant アドオン" icon="home" href="https://github.com/ngutman/openclaw-ha-addon">
  **@ngutman** • `homeassistant` `docker` `raspberry-pi`
  
  SSH トンネルサポートと永続的な状態を備えた、Home Assistant OS 上で動作する OpenClaw Gateway ゲートウェイ。
</Card>

<Card title="Home Assistant Skill" icon="toggle-on" href="https://clawhub.com/skills/homeassistant">
  **ClawHub** • `homeassistant` `skill` `automation`
  
  自然言語で Home Assistant デバイスを制御・自動化。
</Card>

<Card title="Nix パッケージング" icon="snowflake" href="https://github.com/openclaw/nix-openclaw">
  **@openclaw** • `nix` `packaging` `deployment`
  
  再現可能なデプロイのためのバッテリー同梱 nix 化 OpenClaw 設定。
</Card>

<Card title="CalDAV カレンダー" icon="calendar" href="https://clawhub.com/skills/caldav-calendar">
  **ClawHub** • `calendar` `caldav` `skill`
  
  khal/vdirsyncer を使用したカレンダー Skill。セルフホスト型カレンダー統合。
</Card>

</CardGroup>

## 🏠 ホームとハードウェア

<CardGroup cols={2}>

<Card title="GoHome 自動化" icon="house-signal" href="https://github.com/joshp123/gohome">
  **@joshp123** • `home` `nix` `grafana`
  
  OpenClaw をインターフェースとした Nix ネイティブのホームオートメーション。美しい Grafana ダッシュボード付き。
  
  <img src="/assets/showcase/gohome-grafana.png" alt="GoHome の Grafana ダッシュボード" />
</Card>

<Card title="Roborock ロボット掃除機" icon="robot" href="https://github.com/joshp123/gohome/tree/main/plugins/roborock">
  **@joshp123** • `vacuum` `iot` `plugin`
  
  自然な会話で Roborock ロボット掃除機を操作。
  
  <img src="/assets/showcase/roborock-screenshot.jpg" alt="Roborock のステータス" />
</Card>

</CardGroup>

## 🌟 コミュニティプロジェクト

<CardGroup cols={2}>

<Card title="StarSwap マーケットプレイス" icon="star" href="https://star-swap.com/">
  **コミュニティ** • `marketplace` `astronomy` `webapp`
  
  天体観測機材のフルマーケットプレイス。OpenClaw エコシステムを活用して構築。
</Card>

</CardGroup>

---

## プロジェクトを投稿する

共有したいものがありますか？ぜひ掲載させてください！

<Steps>
  <Step title="共有する">
    [Discord の #self-promotion](https://discord.gg/clawd) に投稿するか、[@openclaw にツイート](https://x.com/openclaw)してください
  </Step>
  <Step title="詳細を含める">
    何をするものか教えてください。リポジトリやデモへのリンク、あればスクリーンショットも共有してください
  </Step>
  <Step title="掲載される">
    優れたプロジェクトをこのページに追加します
  </Step>
</Steps>
