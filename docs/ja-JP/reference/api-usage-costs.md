---
read_when:
    - 有料APIを呼び出す可能性のある機能を理解したい場合
    - キー、コスト、使用状況の可視性を監査する必要がある場合
    - /statusや/usageのコストレポートについて説明する場合
summary: 費用が発生する可能性のある機能、使用されるキー、使用状況の確認方法を監査する
title: APIの使用状況とコスト
x-i18n:
    generated_at: "2026-04-02T07:51:40Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: e67f8a500418c551d53948ab9f4702d71d5d9fdf1ab7dfa6823097ba79dd10b7
    source_path: reference/api-usage-costs.md
    workflow: 15
---

# APIの使用状況とコスト

このドキュメントでは、**APIキーを呼び出す可能性のある機能**と、そのコストがどこに表示されるかを一覧にしています。プロバイダーの使用量や有料API呼び出しを生成する可能性のあるOpenClawの機能に焦点を当てています。

## コストの表示場所（チャット + CLI）

**セッションごとのコストスナップショット**

- `/status`は、現在のセッションのモデル、コンテキスト使用量、最後のレスポンストークンを表示します。
- モデルが**APIキー認証**を使用している場合、`/status`は最後の返信の**推定コスト**も表示します。

**メッセージごとのコストフッター**

- `/usage full`は、**推定コスト**（APIキーのみ）を含む使用状況フッターをすべての返信に追加します。
- `/usage tokens`はトークンのみを表示します。OAuthフローではドルコストは非表示になります。

**CLIの使用量ウィンドウ（プロバイダークォータ）**

- `openclaw status --usage`と`openclaw channels list`は、プロバイダーの**使用量ウィンドウ**（クォータスナップショット、メッセージごとのコストではない）を表示します。

詳細と例については[トークンの使用量とコスト](/reference/token-use)を参照してください。

## キーの検出方法

OpenClawは以下からクレデンシャルを取得できます:

- **認証プロファイル**（エージェントごと、`auth-profiles.json`に保存）。
- **環境変数**（例: `OPENAI_API_KEY`、`BRAVE_API_KEY`、`FIRECRAWL_API_KEY`）。
- **設定**（`models.providers.*.apiKey`、`tools.web.search.*`、`tools.web.fetch.firecrawl.*`、`memorySearch.*`、`talk.apiKey`）。
- **Skills**（`skills.entries.<name>.apiKey`）。Skillプロセスの環境変数にキーをエクスポートする場合があります。

## キーを消費する可能性のある機能

### 1) コアモデルレスポンス（チャット + ツール）

すべての返信やツール呼び出しは、**現在のモデルプロバイダー**（OpenAI、Anthropicなど）を使用します。これが使用量とコストの主な発生源です。

料金設定については[モデル](/providers/models)を、表示については[トークンの使用量とコスト](/reference/token-use)を参照してください。

### 2) メディア理解（音声/画像/動画）

受信メディアは、返信の実行前に要約/文字起こしされることがあります。これにはモデル/プロバイダーAPIが使用されます。

- 音声: OpenAI / Groq / Deepgram（キーが存在する場合は**自動有効化**）。
- 画像: OpenAI / Anthropic / Google。
- 動画: Google。

[メディア理解](/nodes/media-understanding)を参照してください。

### 3) メモリ埋め込み + セマンティック検索

セマンティックメモリ検索は、リモートプロバイダー用に設定されている場合、**埋め込みAPI**を使用します:

- `memorySearch.provider = "openai"` → OpenAI埋め込み
- `memorySearch.provider = "gemini"` → Gemini埋め込み
- `memorySearch.provider = "voyage"` → Voyage埋め込み
- `memorySearch.provider = "mistral"` → Mistral埋め込み
- `memorySearch.provider = "ollama"` → Ollama埋め込み（ローカル/セルフホスト、通常ホスト型APIの課金なし）
- ローカル埋め込みが失敗した場合のリモートプロバイダーへのオプションのフォールバック

`memorySearch.provider = "local"`でローカルに保持できます（API使用なし）。

[メモリ](/concepts/memory)を参照してください。

### 4) Web検索ツール

`web_search`はAPIキーを使用し、プロバイダーによっては使用料金が発生する場合があります:

- **Brave Search API**: `BRAVE_API_KEY`または`plugins.entries.brave.config.webSearch.apiKey`
- **Gemini (Google Search)**: `GEMINI_API_KEY`または`plugins.entries.google.config.webSearch.apiKey`
- **Grok (xAI)**: `XAI_API_KEY`または`plugins.entries.xai.config.webSearch.apiKey`
- **Kimi (Moonshot)**: `KIMI_API_KEY`、`MOONSHOT_API_KEY`、または`plugins.entries.moonshot.config.webSearch.apiKey`
- **Perplexity Search API**: `PERPLEXITY_API_KEY`、`OPENROUTER_API_KEY`、または`plugins.entries.perplexity.config.webSearch.apiKey`

レガシーの`tools.web.search.*`プロバイダーパスは一時的な互換性シムを通じて引き続きロードされますが、推奨される設定サーフェスではなくなりました。

**Brave Searchの無料クレジット:** 各Braveプランには月額\$5の更新される無料クレジットが含まれています。Searchプランは1,000リクエストあたり\$5のため、このクレジットで月1,000リクエストまで無料で利用できます。予期しない請求を避けるため、Braveダッシュボードで使用量の上限を設定してください。

[Webツール](/tools/web)を参照してください。

### 5) Webフェッチツール（Firecrawl）

`web_fetch`は、APIキーが存在する場合に**Firecrawl**を呼び出すことができます:

- `FIRECRAWL_API_KEY`または`tools.web.fetch.firecrawl.apiKey`

Firecrawlが設定されていない場合、ツールはダイレクトフェッチ + readabilityにフォールバックします（有料APIなし）。

[Webツール](/tools/web)を参照してください。

### 6) プロバイダー使用量スナップショット（ステータス/ヘルス）

一部のステータスコマンドは、クォータウィンドウや認証ヘルスを表示するために**プロバイダーの使用量エンドポイント**を呼び出します。これらは通常低ボリュームの呼び出しですが、プロバイダーAPIにアクセスします:

- `openclaw status --usage`
- `openclaw models status --json`

[モデルCLI](/cli/models)を参照してください。

### 7) コンパクション セーフガード要約

コンパクションセーフガードは、**現在のモデル**を使用してセッション履歴を要約することができ、実行時にプロバイダーAPIを呼び出します。

[セッション管理 + コンパクション](/reference/session-management-compaction)を参照してください。

### 8) モデルスキャン / プローブ

`openclaw models scan`はOpenRouterモデルをプローブでき、プローブが有効な場合は`OPENROUTER_API_KEY`を使用します。

[モデルCLI](/cli/models)を参照してください。

### 9) Talk（音声）

Talkモードは、設定されている場合に**ElevenLabs**を呼び出すことができます:

- `ELEVENLABS_API_KEY`または`talk.apiKey`

[Talkモード](/nodes/talk)を参照してください。

### 10) Skills（サードパーティAPI）

Skillsは`skills.entries.<name>.apiKey`にAPIキーを保存できます。Skillがそのキーを外部APIに使用する場合、そのSkillのプロバイダーに応じてコストが発生する可能性があります。

[Skills](/tools/skills)を参照してください。
