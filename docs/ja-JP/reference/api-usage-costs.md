---
summary: "費用が発生する可能性のある機能、使用するキー、使用状況の確認方法を調査します"
read_when:
  - どの機能が有料 API を呼び出す可能性があるかを理解したいとき
  - キー、コスト、使用状況の可視性を監査する必要があるとき
  - /status または /usage コストレポートを説明するとき
title: "API の使用状況とコスト"
---

# API の使用状況とコスト

このドキュメントは、**API キーを呼び出す可能性のある機能**とそのコストがどこに表示されるかを一覧表示します。プロバイダーの使用量や有料 API 呼び出しを発生させる可能性のある OpenClaw の機能に焦点を当てています。

## コストが表示される場所（チャット + CLI）

**セッションごとのコストスナップショット**

- `/status` は現在のセッションモデル、コンテキスト使用量、最後のレスポンストークンを表示します。
- モデルが **API キー認証**を使用している場合、`/status` は最後の返信の**推定コスト**も表示します。

**メッセージごとのコストフッター**

- `/usage full` はすべての返信に使用状況フッターを追加し、**推定コスト**（API キーのみ）を含みます。
- `/usage tokens` はトークンのみを表示します。OAuth フローではドルコストは非表示になります。

**CLI 使用ウィンドウ（プロバイダークォータ）**

- `openclaw status --usage` と `openclaw channels list` はプロバイダーの**使用ウィンドウ**を表示します
  （クォータのスナップショットであり、メッセージごとのコストではありません）。

詳細と例については [トークンの使用とコスト](/reference/token-use) を参照してください。

## キーの検出方法

OpenClaw は次の場所から認証情報を取得できます:

- **認証プロファイル**（エージェントごと、`auth-profiles.json` に保存）。
- **環境変数**（例: `OPENAI_API_KEY`、`BRAVE_API_KEY`、`FIRECRAWL_API_KEY`）。
- **設定**（`models.providers.*.apiKey`、`tools.web.search.*`、`tools.web.fetch.firecrawl.*`、
  `memorySearch.*`、`talk.apiKey`）。
- **スキル**（`skills.entries.<name>.apiKey`）は、スキルプロセス環境にキーをエクスポートする場合があります。

## キーを消費する可能性のある機能

### 1) コアモデルのレスポンス（チャット + ツール）

すべての返信またはツール呼び出しは**現在のモデルプロバイダー**（OpenAI、Anthropic など）を使用します。これが使用量とコストの主な発生源です。

価格設定については [モデル](/providers/models)、表示については [トークンの使用とコスト](/reference/token-use) を参照してください。

### 2) メディア理解（音声/画像/動画）

受信メディアは、返信が実行される前に要約/文字起こしされる場合があります。これはモデル/プロバイダー API を使用します。

- 音声: OpenAI / Groq / Deepgram（キーが存在する場合は現在**自動的に有効化**されます）。
- 画像: OpenAI / Anthropic / Google。
- 動画: Google。

[メディア理解](/nodes/media-understanding) を参照してください。

### 3) メモリ埋め込み + セマンティック検索

セマンティックメモリ検索は、リモートプロバイダー用に設定されている場合に**埋め込み API** を使用します:

- `memorySearch.provider = "openai"` → OpenAI 埋め込み
- `memorySearch.provider = "gemini"` → Gemini 埋め込み
- `memorySearch.provider = "voyage"` → Voyage 埋め込み
- `memorySearch.provider = "mistral"` → Mistral 埋め込み
- ローカル埋め込みが失敗した場合のリモートプロバイダーへのオプションのフォールバック

`memorySearch.provider = "local"` でローカルのままにすることができます（API 使用なし）。

[メモリ](/concepts/memory) を参照してください。

### 4) Web 検索ツール（Brave / OpenRouter 経由の Perplexity）

`web_search` は API キーを使用し、使用料が発生する場合があります:

- **Brave Search API**: `BRAVE_API_KEY` または `tools.web.search.apiKey`
- **Perplexity**（OpenRouter 経由）: `PERPLEXITY_API_KEY` または `OPENROUTER_API_KEY`

**Brave の無料プラン（寛大な制限）:**

- **月 2,000 リクエスト**
- **1 リクエスト/秒**
- **クレジットカードが必要**（確認のみ。アップグレードしない限り課金なし）

[Web ツール](/tools/web) を参照してください。

### 5) Web フェッチツール（Firecrawl）

`web_fetch` は API キーが存在する場合に **Firecrawl** を呼び出せます:

- `FIRECRAWL_API_KEY` または `tools.web.fetch.firecrawl.apiKey`

Firecrawl が設定されていない場合、ツールは直接フェッチ + readability にフォールバックします（有料 API なし）。

[Web ツール](/tools/web) を参照してください。

### 6) プロバイダー使用スナップショット（状態/ヘルス）

一部のステータスコマンドは、クォータウィンドウや認証の状態を表示するために**プロバイダーの使用エンドポイント**を呼び出します。これらは通常、低ボリュームの呼び出しですが、プロバイダー API にアクセスします:

- `openclaw status --usage`
- `openclaw models status --json`

[モデル CLI](/cli/models) を参照してください。

### 7) コンパクションセーフガードの要約

コンパクションセーフガードは、**現在のモデル**を使用してセッション履歴を要約できます。実行されるとプロバイダー API を呼び出します。

[セッション管理 + コンパクション](/reference/session-management-compaction) を参照してください。

### 8) モデルスキャン / プローブ

`openclaw models scan` は OpenRouter モデルをプローブでき、プローブが有効な場合に `OPENROUTER_API_KEY` を使用します。

[モデル CLI](/cli/models) を参照してください。

### 9) トーク（音声）

トークモードは、設定されている場合に **ElevenLabs** を呼び出せます:

- `ELEVENLABS_API_KEY` または `talk.apiKey`

[トークモード](/nodes/talk) を参照してください。

### 10) スキル（サードパーティ API）

スキルは `skills.entries.<name>.apiKey` に `apiKey` を保存できます。スキルがそのキーを外部 API に使用する場合、スキルのプロバイダーに応じてコストが発生する可能性があります。

[スキル](/tools/skills) を参照してください。
