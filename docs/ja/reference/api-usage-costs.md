---
summary: "どの機能が費用を発生させ得るか、どのキーが使用されているか、そして使用状況をどのように確認するかを監査します"
read_when:
  - どの機能が有料 API を呼び出す可能性があるかを理解したい場合
  - キー、コスト、使用状況の可視性を監査する必要がある場合
  - /status や /usage のコスト報告を説明している場合
title: "API 使用量とコスト"
---

# API 使用量 & コスト

このドキュメントでは、**API キーを呼び出す可能性のある機能**と、そのコストがどこに表示されるかを一覧します。  
プロバイダーの使用量や有料 API 呼び出しを生成し得る OpenClaw の機能に焦点を当てています。 6. プロバイダー利用量や有料 API コールを発生させる可能性のある
OpenClaw の機能に焦点を当てています。

## コストの表示場所（チャット + CLI）

**セッションごとのコスト スナップショット**

- `/status` は、現在のセッションのモデル、コンテキスト使用量、直近の応答トークンを表示します。
- モデルが **API キー認証**を使用している場合、`/status` は直近の返信に対する **推定コスト** も表示します。

**メッセージごとのコスト フッター**

- `/usage full` は、すべての返信に **推定コスト**（API キー使用時のみ）を含む使用量フッターを付加します。
- `/usage tokens` はトークンのみを表示します。OAuth フローでは金額コストは非表示になります。

**CLI の使用量ウィンドウ（プロバイダーのクォータ）**

- `openclaw status --usage` および `openclaw channels list` は、プロバイダーの **使用量ウィンドウ** を表示します  
  （メッセージ単位のコストではなく、クォータのスナップショット）。

詳細と例については、[Token use & costs](/reference/token-use) を参照してください。

## キーの検出方法

OpenClaw は、次の場所から認証情報を取得できます。

- **認証プロファイル**（エージェントごと、`auth-profiles.json` に保存）。
- **環境変数**（例: `OPENAI_API_KEY`, `BRAVE_API_KEY`, `FIRECRAWL_API_KEY`）。
- **設定**（`models.providers.*.apiKey`, `tools.web.search.*`, `tools.web.fetch.firecrawl.*`,  
  `memorySearch.*`, `talk.apiKey`）。
- **Skills**（`skills.entries.<name>.apiKey`）。スキル プロセスの環境変数にキーをエクスポートする場合があります。

## キーを消費する可能性のある機能

### 1. コア モデルの応答（チャット + ツール）

すべての返信やツール呼び出しは **現在のモデル プロバイダー**（OpenAI、Anthropic など）を使用します。  
これが使用量とコストの主な発生源です。 これが
主要な使用量とコスト源です。

価格設定については [Models](/providers/models)、表示については [Token use & costs](/reference/token-use) を参照してください。

### 2. メディア理解（音声 / 画像 / 動画）

返信が実行される前に、インバウンドメディアを要約/転写することができます。 これは model/provider API を使用します。

- 音声: OpenAI / Groq / Deepgram（キーが存在する場合は **自動有効**）。
- 画像: OpenAI / Anthropic / Google。
- 動画: Google。

[Media understanding](/nodes/media-understanding) を参照してください。

### 3. メモリー埋め込み + セマンティック検索

セマンティック メモリー検索は、リモート プロバイダー向けに設定されている場合、**埋め込み API** を使用します。

- `memorySearch.provider = "openai"` → OpenAI embeddings
- `memorySearch.provider = "gemini"` → Gemini embeddings
- `memorySearch.provider = "voyage"` → Voyage embeddings
- ローカル埋め込みが失敗した場合、リモート プロバイダーへのフォールバック（任意）

`memorySearch.provider = "local"` を使用すればローカルのままにできます（API 使用なし）。

[Memory](/concepts/memory) を参照してください。

### 4. Web 検索ツール（Brave / Perplexity via OpenRouter）

`web_search` は API キーを使用し、使用量課金が発生する場合があります。

- **Brave Search API**: `BRAVE_API_KEY` または `tools.web.search.apiKey`
- **Perplexity**（OpenRouter 経由）: `PERPLEXITY_API_KEY` または `OPENROUTER_API_KEY`

**Brave の無料枠（十分に寛大）:**

- **月 2,000 リクエスト**
- **毎秒 1 リクエスト**
- **クレジットカードが必要**（認証目的。アップグレードしない限り課金なし）

[Web tools](/tools/web) を参照してください。

### 5. Web フェッチ ツール（Firecrawl）

`web_fetch` は、API キーが存在する場合に **Firecrawl** を呼び出すことがあります。

- `FIRECRAWL_API_KEY` または `tools.web.fetch.firecrawl.apiKey`

Firecrawl が設定されていない場合、ツールは直接フェッチ + 可読性処理にフォールバックします（有料 API なし）。

[Web tools](/tools/web) を参照してください。

### 6. プロバイダー使用量スナップショット（ステータス / ヘルス）

ステータスコマンドの中には、クオータウィンドウや認証ヘルスを表示するために**プロバイダ使用のエンドポイント** を呼び出します。
これらは通常低音量の呼び出しですが、まだヒットプロバイダAPIです。

- `openclaw status --usage`
- `openclaw models status --json`

[Models CLI](/cli/models) を参照してください。

### 7. 圧縮セーフガードの要約

圧縮セーフガードは **現在のモデル** を使用してセッション履歴を要約でき、実行時にプロバイダーの API を呼び出します。

[Session management + compaction](/reference/session-management-compaction) を参照してください。

### 8. モデル スキャン / プローブ

`openclaw models scan` は OpenRouter のモデルをプローブでき、  
プローブが有効な場合は `OPENROUTER_API_KEY` を使用します。

[Models CLI](/cli/models) を参照してください。

### 9. Talk（音声）

Talk モードは、設定されている場合に **ElevenLabs** を呼び出すことがあります。

- `ELEVENLABS_API_KEY` または `talk.apiKey`

[Talk mode](/nodes/talk) を参照してください。

### 10. Skills（サードパーティ API）

Skills は `apiKey` を `skills.entries.<name>.apiKey` に関連付けられた環境変数名。 スキルが外部の
API のためにそのキーを使用する場合、スキルプロバイダに応じてコストがかかる可能性があります。

[Skills](/tools/skills) を参照してください。
