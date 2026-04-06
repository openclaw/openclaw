---
summary: "Hooks: コマンドとライフサイクルイベントのためのイベント駆動型自動化"
read_when:
  - /new、/reset、/stop、エージェントライフサイクルイベントのイベント駆動型自動化が必要な場合
  - フックのビルド、インストール、またはデバッグが必要な場合
title: "フック"
x-i18n:
    generated_at: "2026-04-03T00:00:00Z"
    model: claude-sonnet-4-6
    provider: anthropic
    source_hash: c43bcaa6ae357fadf525eca529eb2459a16a7bd9c222ba9483c071c79c516190
    source_path: automation/hooks.md
    workflow: 15
---

# フック

フックはエージェントコマンドとイベントに応答してアクションを自動化するための拡張可能なイベント駆動型システムを提供します。フックはディレクトリから自動的に検出され `openclaw hooks` で確認できます。フックパックのインストールと更新は `openclaw plugins` を通じて行います。

## 概要

フックとは、何かが起こったときに実行される小さなスクリプトです。2種類あります：

- **フック**（このページ）：`/new`、`/reset`、`/stop`、またはライフサイクルイベントなどのエージェントイベントが発生したときに Gateway ゲートウェイ内部で実行されます。
- **Webhook**：他のシステムが OpenClaw で作業をトリガーできる外部 HTTP Webhook。[Webhook フック](/automation/webhook) を参照するか、Gmail ヘルパーコマンドには `openclaw webhooks` を使用してください。

フックはプラグイン内にもバンドルできます；[プラグインフック](/plugins/architecture#provider-runtime-hooks) を参照してください。`openclaw hooks list` はスタンドアロンフックとプラグイン管理フックの両方を表示します。

一般的な使用例：

- セッションをリセットするときにメモリスナップショットを保存する
- トラブルシューティングやコンプライアンスのためにコマンドの監査証跡を保持する
- セッションの開始または終了時にフォローアップ自動化をトリガーする
- イベントが発生したときにエージェントワークスペースにファイルを書き込んだり外部 API を呼び出したりする

TypeScript の小さな関数を書けるなら、フックを書けます。マネージドおよびバンドルフックは信頼されたローカルコードです。ワークスペースフックは自動的に検出されますが、OpenClaw は CLI または設定で明示的に有効にするまでそれらを無効にしておきます。

## 概要

フックシステムでできること：

- `/new` が発行されたときにセッションコンテキストをメモリに保存する
- 監査のためにすべてのコマンドをログに記録する
- エージェントライフサイクルイベントでカスタム自動化をトリガーする
- コアコードを変更せずに OpenClaw の動作を拡張する

## はじめに

### バンドルフック

OpenClaw には4つのバンドルフックが付属しており、自動的に検出されます：

- **💾 session-memory**：`/new` または `/reset` を発行したときにセッションコンテキストをエージェントワークスペース（デフォルト `~/.openclaw/workspace/memory/`）に保存します
- **📎 bootstrap-extra-files**：`agent:bootstrap` 中に設定されたグロブ/パターンから追加のワークスペースブートストラップファイルを注入します
- **📝 command-logger**：すべてのコマンドイベントを `~/.openclaw/logs/commands.log` にログ記録します
- **🚀 boot-md**：Gateway ゲートウェイ起動時に `BOOT.md` を実行します（内部フックが有効な場合に必要）

利用可能なフックを一覧表示：

```bash
openclaw hooks list
```

フックを有効化：

```bash
openclaw hooks enable session-memory
```

フックのステータスを確認：

```bash
openclaw hooks check
```

詳細情報を取得：

```bash
openclaw hooks info session-memory
```

### オンボーディング

オンボーディング（`openclaw onboard`）中に、推奨フックを有効にするよう促されます。ウィザードは自動的に対象フックを検出し、選択のために提示します。

### 信頼の境界

フックは Gateway ゲートウェイプロセス内で実行されます。バンドルフック、マネージドフック、`hooks.internal.load.extraDirs` を信頼されたローカルコードとして扱ってください。`<workspace>/hooks/` 配下のワークスペースフックはリポジトリローカルコードであるため、OpenClaw はロードする前に明示的な有効化ステップを必要とします。

## フック検出

フックはこれらのディレクトリから自動的に検出されます（オーバーライドの優先度が高い順）：

1. **バンドルフック**：OpenClaw に同梱；npm インストールの場合 `<openclaw>/dist/hooks/bundled/` に配置（コンパイル済みバイナリの場合は `hooks/bundled/` がサイドバイサイド）
2. **プラグインフック**：インストールされたプラグイン内にバンドルされたフック（[プラグインフック](/plugins/architecture#provider-runtime-hooks) を参照）
3. **マネージドフック**：`~/.openclaw/hooks/`（ユーザーインストール、ワークスペース間で共有；バンドルおよびプラグインフックをオーバーライド可能）。`hooks.internal.load.extraDirs` で設定された**追加フックディレクトリ**もマネージドフックとして扱われ、同じオーバーライドの優先度を共有します。
4. **ワークスペースフック**：`<workspace>/hooks/`（エージェントごと；明示的に有効化されるまでデフォルトで無効；他のソースのフックをオーバーライド不可）

ワークスペースフックはリポジトリに新しいフック名を追加できますが、同じ名前のバンドル、マネージド、またはプラグイン提供フックはオーバーライドできません。

マネージドフックディレクトリは**単一フック**または**フックパック**（パッケージディレクトリ）のどちらかです。

各フックは以下を含むディレクトリです：

```
my-hook/
├── HOOK.md          # メタデータ + ドキュメント
└── handler.ts       # ハンドラー実装
```

## フックパック（npm/アーカイブ）

フックパックは `package.json` の `openclaw.hooks` を介して1つ以上のフックをエクスポートする標準の npm パッケージです。以下でインストールします：

```bash
openclaw plugins install <path-or-spec>
```

npm スペックはレジストリのみです（パッケージ名 + オプションの正確なバージョンまたは dist タグ）。
Git/URL/ファイルスペックとセマーバーレンジは拒否されます。

ベアスペックと `@latest` は安定トラックに留まります。npm がこれらをプレリリースに解決した場合、OpenClaw は停止し、`@beta`/`@rc` などのプレリリースタグまたは正確なプレリリースバージョンでオプトインするよう求めます。

`package.json` の例：

```json
{
  "name": "@acme/my-hooks",
  "version": "0.1.0",
  "openclaw": {
    "hooks": ["./hooks/my-hook", "./hooks/other-hook"]
  }
}
```

各エントリは `HOOK.md` とハンドラーファイルを含むフックディレクトリを指します。ローダーは `handler.ts`、`handler.js`、`index.ts`、`index.js` の順に試みます。
フックパックは依存関係を含めることができます；それらは `~/.openclaw/hooks/<id>` にインストールされます。
各 `openclaw.hooks` エントリはシンボリックリンク解決後にパッケージディレクトリ内に留まる必要があります；外に出るエントリは拒否されます。

セキュリティノート：`openclaw plugins install` はフックパックの依存関係を `npm install --ignore-scripts`（ライフサイクルスクリプトなし）でインストールします。フックパックの依存関係ツリーを「純粋 JS/TS」に保ち、`postinstall` ビルドに依存するパッケージを避けてください。

## フック構造

### HOOK.md フォーマット

`HOOK.md` ファイルには YAML フロントマターと Markdown ドキュメントが含まれます：

```markdown
---
name: my-hook
description: "このフックが何をするかの短い説明"
homepage: https://docs.openclaw.ai/automation/hooks#my-hook
metadata:
  { "openclaw": { "emoji": "🔗", "events": ["command:new"], "requires": { "bins": ["node"] } } }
---

# マイフック

詳細なドキュメントはここに...

## 何をするか

- `/new` コマンドをリッスンする
- 何らかのアクションを実行する
- 結果をログに記録する

## 要件

- Node.js がインストールされている必要あり

## 設定

設定は不要です。
```

### メタデータフィールド

`metadata.openclaw` オブジェクトのサポート：

- **`emoji`**：CLI の表示絵文字（例：`"💾"`）
- **`events`**：リッスンするイベントの配列（例：`["command:new", "command:reset"]`）
- **`export`**：使用する名前付きエクスポート（デフォルトは `"default"`）
- **`homepage`**：ドキュメント URL
- **`os`**：必要なプラットフォーム（例：`["darwin", "linux"]`）
- **`requires`**：オプションの要件
  - **`bins`**：PATH 上に必要なバイナリ（例：`["git", "node"]`）
  - **`anyBins`**：これらのバイナリのうち少なくとも1つが必要
  - **`env`**：必要な環境変数
  - **`config`**：必要な設定パス（例：`["workspace.dir"]`）
- **`always`**：適格性チェックをバイパス（ブール値）
- **`install`**：インストール方法（バンドルフックの場合：`[{"id":"bundled","kind":"bundled"}]`）

### ハンドラー実装

`handler.ts` ファイルは `HookHandler` 関数をエクスポートします：

```typescript
const myHandler = async (event) => {
  // 'new' コマンドのみトリガー
  if (event.type !== "command" || event.action !== "new") {
    return;
  }

  console.log(`[my-hook] New command triggered`);
  console.log(`  Session: ${event.sessionKey}`);
  console.log(`  Timestamp: ${event.timestamp.toISOString()}`);

  // カスタムロジックはここに

  // オプションでユーザーにメッセージを送信
  event.messages.push("✨ My hook executed!");
};

export default myHandler;
```

#### イベントコンテキスト

各イベントには以下が含まれます：

```typescript
{
  type: 'command' | 'session' | 'agent' | 'gateway' | 'message',
  action: string,              // 例：'new', 'reset', 'stop', 'received', 'sent'
  sessionKey: string,          // セッション識別子
  timestamp: Date,             // イベント発生時刻
  messages: string[],          // ユーザーへのメッセージをここにプッシュ
  context: {
    // コマンドイベント (command:new, command:reset):
    sessionEntry?: SessionEntry,       // 現在のセッションエントリ
    previousSessionEntry?: SessionEntry, // リセット前のエントリ（session-memory に推奨）
    commandSource?: string,            // 例：'whatsapp', 'telegram'
    senderId?: string,
    workspaceDir?: string,
    cfg?: OpenClawConfig,
    // コマンドイベント (command:stop のみ):
    sessionId?: string,
    // エージェントブートストラップイベント (agent:bootstrap):
    bootstrapFiles?: WorkspaceBootstrapFile[],
    sessionKey?: string,           // ルーティングセッションキー
    sessionId?: string,            // 内部セッション UUID
    agentId?: string,              // 解決されたエージェント ID
    // メッセージイベント（詳細はメッセージイベントセクションを参照）:
    from?: string,             // message:received
    to?: string,               // message:sent
    content?: string,
    channelId?: string,
    success?: boolean,         // message:sent
  }
}
```

## イベントタイプ

### コマンドイベント

エージェントコマンドが発行されたときにトリガーされます：

- **`command`**：すべてのコマンドイベント（一般リスナー）
- **`command:new`**：`/new` コマンドが発行されたとき
- **`command:reset`**：`/reset` コマンドが発行されたとき
- **`command:stop`**：`/stop` コマンドが発行されたとき

### セッションイベント

- **`session:compact:before`**：コンパクションが履歴を要約する直前
- **`session:compact:after`**：コンパクションがサマリーメタデータとともに完了した後

内部フックペイロードはこれらを `type: "session"` と `action: "compact:before"` / `action: "compact:after"` として発行します；リスナーは上記の結合キーでサブスクライブします。
特定のハンドラー登録はリテラルキー形式 `${type}:${action}` を使用します。これらのイベントには `session:compact:before` と `session:compact:after` を登録してください。

`session:compact:before` コンテキストフィールド：

- `sessionId`：内部セッション UUID
- `missingSessionKey`：セッションキーが利用できなかった場合に true
- `messageCount`：コンパクション前のメッセージ数
- `tokenCount`：コンパクション前のトークン数（存在しない場合あり）
- `messageCountOriginal`：完全な未切り詰めセッション履歴からのメッセージ数
- `tokenCountOriginal`：完全な元の履歴のトークン数（存在しない場合あり）

`session:compact:after` コンテキストフィールド（`sessionId` と `missingSessionKey` に加えて）：

- `messageCount`：コンパクション後のメッセージ数
- `tokenCount`：コンパクション後のトークン数（存在しない場合あり）
- `compactedCount`：コンパクション/削除されたメッセージ数
- `summaryLength`：生成されたコンパクションサマリーの文字長
- `tokensBefore`：コンパクション前のトークン数（差分計算用）
- `tokensAfter`：コンパクション後のトークン数
- `firstKeptEntryId`：コンパクション後に保持された最初のメッセージエントリの ID

### エージェントイベント

- **`agent:bootstrap`**：ワークスペースブートストラップファイルが注入される前（フックは `context.bootstrapFiles` を変更可能）

### Gateway ゲートウェイイベント

Gateway ゲートウェイが起動したときにトリガーされます：

- **`gateway:startup`**：チャンネルが起動しフックがロードされた後

### セッションパッチイベント

セッションプロパティが変更されたときにトリガーされます：

- **`session:patch`**：セッションが更新されたとき

#### セッションイベントコンテキスト

セッションイベントにはセッションと変更に関する豊富なコンテキストが含まれます：

```typescript
{
  sessionEntry: SessionEntry, // 完全な更新済みセッションエントリ
  patch: {                    // パッチオブジェクト（変更されたフィールドのみ）
    // セッション識別とラベリング
    label?: string | null,           // 人間が読めるセッションラベル

    // AI モデル設定
    model?: string | null,           // モデルオーバーライド（例："claude-sonnet-4-6"）
    thinkingLevel?: string | null,   // 思考レベル（"off"|"low"|"med"|"high"）
    verboseLevel?: string | null,    // 詳細出力レベル
    reasoningLevel?: string | null,  // 推論モードオーバーライド
    elevatedLevel?: string | null,   // 昇格モードオーバーライド
    responseUsage?: "off" | "tokens" | "full" | "on" | null, // 使用状況表示モード
    fastMode?: boolean | null,                    // 高速/ターボモードトグル
    spawnedWorkspaceDir?: string | null,          // スポーンされたサブエージェントのワークスペースディレクトリオーバーライド
    subagentRole?: "orchestrator" | "leaf" | null, // サブエージェントロール割り当て
    subagentControlScope?: "children" | "none" | null, // サブエージェント制御のスコープ

    // ツール実行設定
    execHost?: string | null,        // 実行ホスト（sandbox|gateway|node）
    execSecurity?: string | null,    // セキュリティモード（deny|allowlist|full）
    execAsk?: string | null,         // 承認モード（off|on-miss|always）
    execNode?: string | null,        // host=node の場合のノード ID

    // サブエージェント調整
    spawnedBy?: string | null,       // 親セッションキー（サブエージェントの場合）
    spawnDepth?: number | null,      // ネスト深度（0 = ルート）

    // 通信ポリシー
    sendPolicy?: "allow" | "deny" | null,          // メッセージ送信ポリシー
    groupActivation?: "mention" | "always" | null, // グループチャット有効化
  },
  cfg: OpenClawConfig            // 現在の Gateway ゲートウェイ設定
}
```

**セキュリティノート：** `session:patch` イベントをトリガーできるのは、Control UI を含む特権クライアントのみです。標準の WebChat クライアントはセッションのパッチ適用がブロックされているため、それらの接続からはフックが発火しません。

完全な型定義については `src/gateway/protocol/schema/sessions.ts` の `SessionsPatchParamsSchema` を参照してください。

#### 例：セッションパッチロガーフック

```typescript
const handler = async (event) => {
  if (event.type !== "session" || event.action !== "patch") {
    return;
  }
  const { patch } = event.context;
  console.log(`[session-patch] Session updated: ${event.sessionKey}`);
  console.log(`[session-patch] Changes:`, patch);
};

export default handler;
```

### メッセージイベント

メッセージが受信または送信されたときにトリガーされます：

- **`message`**：すべてのメッセージイベント（一般リスナー）
- **`message:received`**：いずれかのチャンネルからインバウンドメッセージを受信したとき。メディア理解の前の処理の早い段階で発火します。コンテンツにはまだ処理されていないメディア添付のための `<media:audio>` などの生プレースホルダーが含まれる場合があります。
- **`message:transcribed`**：音声文字起こしとリンク理解を含むすべての処理が完了したとき。この時点で `transcript` に音声メッセージの完全な文字起こしテキストが含まれます。文字起こしされた音声コンテンツにアクセスが必要な場合はこのフックを使用してください。
- **`message:preprocessed`**：すべてのメディア + リンク理解が完了した後、すべてのメッセージに対して発火します。エージェントが見る前に完全に強化されたボディ（文字起こし、画像の説明、リンクサマリー）へのアクセスをフックに提供します。
- **`message:sent`**：アウトバウンドメッセージが正常に送信されたとき

#### メッセージイベントコンテキスト

メッセージイベントにはメッセージに関する豊富なコンテキストが含まれます：

```typescript
// message:received コンテキスト
{
  from: string,           // 送信者識別子（電話番号、ユーザー ID など）
  content: string,        // メッセージコンテンツ
  timestamp?: number,     // 受信時の Unix タイムスタンプ
  channelId: string,      // チャンネル（例："whatsapp", "telegram", "discord"）
  accountId?: string,     // マルチアカウントセットアップのプロバイダーアカウント ID
  conversationId?: string, // チャット/会話 ID
  messageId?: string,     // プロバイダーからのメッセージ ID
  metadata?: {            // 追加のプロバイダー固有データ
    to?: string,
    provider?: string,
    surface?: string,
    threadId?: string | number,
    senderId?: string,
    senderName?: string,
    senderUsername?: string,
    senderE164?: string,
    guildId?: string,     // Discord ギルド/サーバー ID
    channelName?: string, // チャンネル名（例：Discord チャンネル名）
  }
}

// message:sent コンテキスト
{
  to: string,             // 受信者識別子
  content: string,        // 送信されたメッセージコンテンツ
  success: boolean,       // 送信が成功したかどうか
  error?: string,         // 送信失敗時のエラーメッセージ
  channelId: string,      // チャンネル（例："whatsapp", "telegram", "discord"）
  accountId?: string,     // プロバイダーアカウント ID
  conversationId?: string, // チャット/会話 ID
  messageId?: string,     // プロバイダーから返されたメッセージ ID
  isGroup?: boolean,      // このアウトバウンドメッセージがグループ/チャンネルコンテキストに属するか
  groupId?: string,       // message:received との相関のためのグループ/チャンネル識別子
}

// message:transcribed コンテキスト
{
  from?: string,          // 送信者識別子
  to?: string,            // 受信者識別子
  body?: string,          // 強化前の生インバウンドボディ
  bodyForAgent?: string,  // エージェントに見える強化されたボディ
  transcript: string,     // 音声文字起こしテキスト
  timestamp?: number,     // 受信時の Unix タイムスタンプ
  channelId: string,      // チャンネル（例："telegram", "whatsapp"）
  conversationId?: string,
  messageId?: string,
  senderId?: string,      // 送信者ユーザー ID
  senderName?: string,    // 送信者表示名
  senderUsername?: string,
  provider?: string,      // プロバイダー名
  surface?: string,       // サーフェス名
  mediaPath?: string,     // 文字起こしされたメディアファイルのパス
  mediaType?: string,     // メディアの MIME タイプ
}

// message:preprocessed コンテキスト
{
  from?: string,          // 送信者識別子
  to?: string,            // 受信者識別子
  body?: string,          // 生インバウンドボディ
  bodyForAgent?: string,  // メディア/リンク理解後の最終強化ボディ
  transcript?: string,    // 音声があった場合の文字起こし
  timestamp?: number,     // 受信時の Unix タイムスタンプ
  channelId: string,      // チャンネル（例："telegram", "whatsapp"）
  conversationId?: string,
  messageId?: string,
  senderId?: string,      // 送信者ユーザー ID
  senderName?: string,    // 送信者表示名
  senderUsername?: string,
  provider?: string,      // プロバイダー名
  surface?: string,       // サーフェス名
  mediaPath?: string,     // メディアファイルのパス
  mediaType?: string,     // メディアの MIME タイプ
  isGroup?: boolean,
  groupId?: string,
}
```

#### 例：メッセージロガーフック

```typescript
const isMessageReceivedEvent = (event: { type: string; action: string }) =>
  event.type === "message" && event.action === "received";
const isMessageSentEvent = (event: { type: string; action: string }) =>
  event.type === "message" && event.action === "sent";

const handler = async (event) => {
  if (isMessageReceivedEvent(event as { type: string; action: string })) {
    console.log(`[message-logger] Received from ${event.context.from}: ${event.context.content}`);
  } else if (isMessageSentEvent(event as { type: string; action: string })) {
    console.log(`[message-logger] Sent to ${event.context.to}: ${event.context.content}`);
  }
};

export default handler;
```

### ツール結果フック（プラグイン API）

これらのフックはイベントストリームリスナーではありません；プラグインが OpenClaw が永続化する前にツール結果を同期的に調整できるようにします。

- **`tool_result_persist`**：ツール結果がセッショントランスクリプトに書き込まれる前に変換します。同期でなければなりません；更新されたツール結果ペイロードを返すか、そのままにする場合は `undefined` を返します。[エージェントループ](/concepts/agent-loop) を参照。

### プラグインフックイベント

#### before_tool_call

各ツールコールの前に実行されます。プラグインはパラメーターを変更したり、コールをブロックしたり、ユーザーの承認を要求したりできます。

返却フィールド：

- **`params`**：ツールパラメーターをオーバーライド（元のパラメーターとマージ）
- **`block`**：ツールコールをブロックするには `true` に設定
- **`blockReason`**：ブロックされたときにエージェントに表示される理由
- **`requireApproval`**：実行を一時停止してチャンネル経由でユーザーの承認を待つ

`requireApproval` フィールドはエージェントに協力させる代わりに、ネイティブプラットフォームの承認（Telegram ボタン、Discord コンポーネント、`/approve` コマンド）をトリガーします：

```typescript
{
  requireApproval: {
    title: "Sensitive operation",
    description: "This tool call modifies production data",
    severity: "warning",       // "info" | "warning" | "critical"
    timeoutMs: 120000,         // デフォルト: 120s
    timeoutBehavior: "deny",   // "allow" | "deny"（デフォルト）
    onResolution: async (decision) => {
      // ユーザーが解決した後に呼び出される: "allow-once", "allow-always", "deny", "timeout", または "cancelled"
    },
  }
}
```

`onResolution` コールバックは承認が解決、タイムアウト、またはキャンセルされた後に最終決定文字列とともに呼び出されます。プラグイン内でインプロセスで実行されます（Gateway ゲートウェイには送信されません）。決定の永続化、キャッシュの更新、またはクリーンアップに使用してください。

`pluginId` フィールドはフックランナーによってプラグイン登録から自動的にスタンプされます。複数のプラグインが `requireApproval` を返す場合、最初のもの（最高優先度）が勝ちます。

`block` は `requireApproval` より優先されます：マージされたフック結果に `block: true` と `requireApproval` フィールドの両方がある場合、承認フローをトリガーせずにツールコールが即座にブロックされます。

Gateway ゲートウェイが利用できないかプラグイン承認をサポートしていない場合、ツールコールは `description` をブロック理由として使用してソフトブロックにフォールバックします。

#### before_install

組み込みインストールセキュリティスキャンの後、インストールが続行される前に実行されます。OpenClaw はインタラクティブなスキルインストールおよびプラグインバンドル、パッケージ、単一ファイルインストールのためにこのフックを発火します。

デフォルト動作はターゲットタイプによって異なります：

- プラグインインストールはオペレーターが明示的に `openclaw plugins install --dangerously-force-unsafe-install` を使用しない限り、組み込みスキャンの `critical` 発見とスキャンエラーでクローズに失敗します。
- スキルインストールは引き続き組み込みスキャンの発見とスキャンエラーを警告として表示し、デフォルトで続行します。

返却フィールド：

- **`findings`**：警告として表示する追加スキャン発見
- **`block`**：インストールをブロックするには `true` に設定
- **`blockReason`**：ブロックされたときに表示される人間が読める理由

イベントフィールド：

- **`targetType`**：インストールターゲットカテゴリ（`skill` または `plugin`）
- **`targetName`**：インストールターゲットの人間が読めるスキル名またはプラグイン ID
- **`sourcePath`**：スキャンされているインストールターゲットコンテンツへの絶対パス
- **`sourcePathKind`**：スキャンされたコンテンツが `file` か `directory` か
- **`origin`**：利用可能な場合の正規化されたインストール元（例：`openclaw-bundled`、`openclaw-workspace`、`plugin-bundle`、`plugin-package`、または `plugin-file`）
- **`request`**：`kind`、`mode`、オプションの `requestedSpecifier` を含むインストールリクエストのプロベナンス
- **`builtinScan`**：`status`、サマリーカウント、発見、オプションの `error` を含む組み込みスキャナーの構造化結果
- **`skill`**：`targetType` が `skill` の場合のスキルインストールメタデータ（`installId` と選択された `installSpec` を含む）
- **`plugin`**：`targetType` が `plugin` の場合のプラグインインストールメタデータ（正規の `pluginId`、正規化された `contentType`、オプションの `packageName` / `manifestId` / `version`、`extensions` を含む）

イベント例（プラグインパッケージインストール）：

```json
{
  "targetType": "plugin",
  "targetName": "acme-audit",
  "sourcePath": "/var/folders/.../openclaw-plugin-acme-audit/package",
  "sourcePathKind": "directory",
  "origin": "plugin-package",
  "request": {
    "kind": "plugin-npm",
    "mode": "install",
    "requestedSpecifier": "@acme/openclaw-plugin-audit@1.4.2"
  },
  "builtinScan": {
    "status": "ok",
    "scannedFiles": 12,
    "critical": 0,
    "warn": 1,
    "info": 0,
    "findings": [
      {
        "severity": "warn",
        "ruleId": "network_fetch",
        "file": "dist/index.js",
        "line": 88,
        "message": "Dynamic network fetch detected during install review."
      }
    ]
  },
  "plugin": {
    "pluginId": "acme-audit",
    "contentType": "package",
    "packageName": "@acme/openclaw-plugin-audit",
    "manifestId": "acme-audit",
    "version": "1.4.2",
    "extensions": ["./dist/index.js"]
  }
}
```

スキルインストールは `targetType: "skill"` と `plugin` オブジェクトの代わりに `skill` オブジェクトを使用した同じイベントシェイプを使用します。

決定のセマンティクス：

- `before_install`：`{ block: true }` は終端で低優先度ハンドラーを停止します。
- `before_install`：`{ block: false }` は決定なしとして扱われます。

インストールソースをインストール前に監査する必要がある外部セキュリティスキャナー、ポリシーエンジン、またはエンタープライズ承認ゲートにこのフックを使用してください。

#### コンパクションライフサイクル

プラグインフックランナーを通じて公開されるコンパクションライフサイクルフック：

- **`before_compaction`**：カウント/トークンメタデータとともにコンパクション前に実行
- **`after_compaction`**：コンパクションサマリーメタデータとともにコンパクション後に実行

### 完全なプラグインフックリファレンス

プラグイン SDK を通じて登録されるすべての28フック。**sequential** とマークされたフックは優先度順に実行され結果を変更できます；**parallel** フックはファイアアンドフォーゲットです。

#### モデルとプロンプトフック

| フック                 | タイミング                                       | 実行       | 返却                                                       |
| ---------------------- | ------------------------------------------------ | ---------- | ---------------------------------------------------------- |
| `before_model_resolve` | モデル/プロバイダー検索の前                       | Sequential | `{ modelOverride?, providerOverride? }`                    |
| `before_prompt_build`  | モデル解決後、セッションメッセージ準備完了後       | Sequential | `{ systemPrompt?, prependContext?, appendSystemContext? }` |
| `before_agent_start`   | レガシー結合フック（上記の2つを推奨）             | Sequential | 両方の結果シェイプの和集合                                 |
| `before_agent_reply`   | インラインアクション後、LLM 実行前               | Sequential | `{ handled: boolean, reply?, reason? }`                    |
| `llm_input`            | LLM API コール直前                               | Parallel   | `void`                                                     |
| `llm_output`           | LLM レスポンス受信直後                           | Parallel   | `void`                                                     |

#### エージェントライフサイクルフック

| フック              | タイミング                                     | 実行      | 返却   |
| ------------------- | ---------------------------------------------- | --------- | ------ |
| `agent_end`         | エージェント実行完了後（成功または失敗）         | Parallel  | `void` |
| `before_reset`      | `/new` または `/reset` がセッションをクリアするとき | Parallel  | `void` |
| `before_compaction` | コンパクションが履歴を要約する前                | Parallel  | `void` |
| `after_compaction`  | コンパクション完了後                           | Parallel  | `void` |

#### セッションライフサイクルフック

| フック          | タイミング                 | 実行      | 返却   |
| --------------- | -------------------------- | --------- | ------ |
| `session_start` | 新しいセッション開始時     | Parallel  | `void` |
| `session_end`   | セッション終了時           | Parallel  | `void` |

#### メッセージフローフック

| フック                 | タイミング                                              | 実行                 | 返却                          |
| ---------------------- | ------------------------------------------------------- | -------------------- | ----------------------------- |
| `inbound_claim`        | コマンド/エージェントディスパッチ前；最初のクレームが勝つ | Sequential           | `{ handled: boolean }`        |
| `message_received`     | インバウンドメッセージ受信後                            | Parallel             | `void`                        |
| `before_dispatch`      | コマンド解析後、モデルディスパッチ前                    | Sequential           | `{ handled: boolean, text? }` |
| `message_sending`      | アウトバウンドメッセージ配信前                          | Sequential           | `{ content?, cancel? }`       |
| `message_sent`         | アウトバウンドメッセージ配信後                          | Parallel             | `void`                        |
| `before_message_write` | メッセージがセッショントランスクリプトに書き込まれる前  | **Sync**, sequential | `{ block?, message? }`        |

#### ツール実行フック

| フック                | タイミング                                   | 実行                 | 返却                                                  |
| --------------------- | -------------------------------------------- | -------------------- | ----------------------------------------------------- |
| `before_tool_call`    | 各ツールコールの前                           | Sequential           | `{ params?, block?, blockReason?, requireApproval? }` |
| `after_tool_call`     | ツールコール完了後                           | Parallel             | `void`                                                |
| `tool_result_persist` | ツール結果がトランスクリプトに書き込まれる前 | **Sync**, sequential | `{ message? }`                                        |

#### サブエージェントフック

| フック                     | タイミング                              | 実行       | 返却                              |
| -------------------------- | --------------------------------------- | ---------- | --------------------------------- |
| `subagent_spawning`        | サブエージェントセッション作成前         | Sequential | `{ status, threadBindingReady? }` |
| `subagent_delivery_target` | スポーニング後、配信ターゲット解決のため | Sequential | `{ origin? }`                     |
| `subagent_spawned`         | サブエージェントが完全にスポーンされた後 | Parallel   | `void`                            |
| `subagent_ended`           | サブエージェントセッション終了時         | Parallel   | `void`                            |

#### Gateway ゲートウェイフック

| フック          | タイミング                               | 実行      | 返却   |
| --------------- | ---------------------------------------- | --------- | ------ |
| `gateway_start` | Gateway ゲートウェイプロセスが完全起動後 | Parallel  | `void` |
| `gateway_stop`  | Gateway ゲートウェイシャットダウン時     | Parallel  | `void` |

#### インストールフック

| フック           | タイミング                                            | 実行       | 返却                                  |
| ---------------- | ----------------------------------------------------- | ---------- | ------------------------------------- |
| `before_install` | 組み込みセキュリティスキャン後、インストール続行前    | Sequential | `{ findings?, block?, blockReason? }` |

<Note>
2つのフック（`tool_result_persist` と `before_message_write`）は**同期のみ** — Promise を返してはなりません。これらのフックから Promise を返すとランタイムで捕捉され、警告とともに結果が破棄されます。
</Note>

完全なハンドラーシグネチャとコンテキストタイプについては、[プラグインアーキテクチャ](/plugins/architecture) を参照してください。

### 将来のイベント

以下のイベントタイプは内部フックイベントストリームの計画中です。
`session_start` と `session_end` はすでに[プラグインフック API](/plugins/architecture#provider-runtime-hooks) フックとして存在しますが、`HOOK.md` メタデータの内部フックイベントキーとしてはまだ利用できません：

- **`session:start`**：新しいセッション開始時（内部フックストリーム計画中；プラグインフック `session_start` として利用可能）
- **`session:end`**：セッション終了時（内部フックストリーム計画中；プラグインフック `session_end` として利用可能）
- **`agent:error`**：エージェントがエラーに遭遇したとき

## カスタムフックの作成

### 1. 場所を選ぶ

- **ワークスペースフック**（`<workspace>/hooks/`）：エージェントごと；新しいフック名を追加できますが、同じ名前のバンドル、マネージド、またはプラグインフックはオーバーライドできません
- **マネージドフック**（`~/.openclaw/hooks/`）：ワークスペース間で共有；バンドルおよびプラグインフックをオーバーライドできます

### 2. ディレクトリ構造を作成する

```bash
mkdir -p ~/.openclaw/hooks/my-hook
cd ~/.openclaw/hooks/my-hook
```

### 3. HOOK.md を作成する

```markdown
---
name: my-hook
description: "何か有用なことをする"
metadata: { "openclaw": { "emoji": "🎯", "events": ["command:new"] } }
---

# マイカスタムフック

このフックは `/new` を発行したときに何か有用なことをします。
```

### 4. handler.ts を作成する

```typescript
const handler = async (event) => {
  if (event.type !== "command" || event.action !== "new") {
    return;
  }

  console.log("[my-hook] Running!");
  // ロジックはここに
};

export default handler;
```

### 5. 有効化してテストする

```bash
# フックが検出されているか確認
openclaw hooks list

# 有効化する
openclaw hooks enable my-hook

# Gateway ゲートウェイプロセスを再起動（macOS のメニューバーアプリ再起動、またはデプロセスを再起動）

# イベントをトリガーする
# メッセージングチャンネルで /new を送信
```

## 設定

### 新しい設定フォーマット（推奨）

```json
{
  "hooks": {
    "internal": {
      "enabled": true,
      "entries": {
        "session-memory": { "enabled": true },
        "command-logger": { "enabled": false }
      }
    }
  }
}
```

### フックごとの設定

フックはカスタム設定を持てます：

```json
{
  "hooks": {
    "internal": {
      "enabled": true,
      "entries": {
        "my-hook": {
          "enabled": true,
          "env": {
            "MY_CUSTOM_VAR": "value"
          }
        }
      }
    }
  }
}
```

### 追加ディレクトリ

追加ディレクトリからフックを読み込む（マネージドフックとして扱われ、同じオーバーライドの優先度）：

```json
{
  "hooks": {
    "internal": {
      "enabled": true,
      "load": {
        "extraDirs": ["/path/to/more/hooks"]
      }
    }
  }
}
```

### レガシー設定フォーマット（引き続きサポート）

古い設定フォーマットは後方互換性のために引き続き動作します：

```json
{
  "hooks": {
    "internal": {
      "enabled": true,
      "handlers": [
        {
          "event": "command:new",
          "module": "./hooks/handlers/my-handler.ts",
          "export": "default"
        }
      ]
    }
  }
}
```

注意：`module` はワークスペース相対パスでなければなりません。絶対パスとワークスペース外へのトラバーサルは拒否されます。

**移行**：新しいフックには新しい検出ベースのシステムを使用してください。レガシーハンドラーはディレクトリベースのフックの後にロードされます。

## CLI コマンド

### フックの一覧表示

```bash
# すべてのフックを一覧表示
openclaw hooks list

# 対象フックのみ表示
openclaw hooks list --eligible

# 詳細出力（不足している要件を表示）
openclaw hooks list --verbose

# JSON 出力
openclaw hooks list --json
```

### フック情報

```bash
# フックの詳細情報を表示
openclaw hooks info session-memory

# JSON 出力
openclaw hooks info session-memory --json
```

### 適格性チェック

```bash
# 適格性サマリーを表示
openclaw hooks check

# JSON 出力
openclaw hooks check --json
```

### 有効化/無効化

```bash
# フックを有効化
openclaw hooks enable session-memory

# フックを無効化
openclaw hooks disable command-logger
```

## バンドルフックリファレンス

### session-memory

`/new` または `/reset` を発行したときにセッションコンテキストをメモリに保存します。

**イベント**：`command:new`、`command:reset`

**要件**：`workspace.dir` が設定されている必要あり

**出力**：`<workspace>/memory/YYYY-MM-DD-slug.md`（デフォルト `~/.openclaw/workspace`）

**何をするか**：

1. リセット前のセッションエントリを使用して正しいトランスクリプトを見つける
2. 会話から最後の15のユーザー/アシスタントメッセージを抽出（設定可能）
3. LLM を使用して説明的なファイル名スラグを生成
4. セッションメタデータを日付付きメモリファイルに保存

**出力例**：

```markdown
# Session: 2026-01-16 14:30:00 UTC

- **Session Key**: agent:main:main
- **Session ID**: abc123def456
- **Source**: telegram

## Conversation Summary

user: Can you help me design the API?
assistant: Sure! Let's start with the endpoints...
```

**ファイル名例**：

- `2026-01-16-vendor-pitch.md`
- `2026-01-16-api-design.md`
- `2026-01-16-1430.md`（スラグ生成失敗時のフォールバックタイムスタンプ）

**有効化**：

```bash
openclaw hooks enable session-memory
```

### bootstrap-extra-files

`agent:bootstrap` 中に追加のブートストラップファイル（例：モノレポローカルの `AGENTS.md` / `TOOLS.md`）を注入します。

**イベント**：`agent:bootstrap`

**要件**：`workspace.dir` が設定されている必要あり

**出力**：ファイルは書き込まれません；ブートストラップコンテキストはメモリ内のみで変更されます。

**設定**：

```json
{
  "hooks": {
    "internal": {
      "enabled": true,
      "entries": {
        "bootstrap-extra-files": {
          "enabled": true,
          "paths": ["packages/*/AGENTS.md", "packages/*/TOOLS.md"]
        }
      }
    }
  }
}
```

**設定オプション**：

- `paths`（string[]）：ワークスペースから解決するグロブ/パターン。
- `patterns`（string[]）：`paths` のエイリアス。
- `files`（string[]）：`paths` のエイリアス。

**注意**：

- パスはワークスペースからの相対で解決されます。
- ファイルはワークスペース内に留まる必要があります（realpath チェック）。
- 認識されたブートストラップベース名のみがロードされます（`AGENTS.md`、`SOUL.md`、`TOOLS.md`、`IDENTITY.md`、`USER.md`、`HEARTBEAT.md`、`BOOTSTRAP.md`、`MEMORY.md`、`memory.md`）。
- サブエージェント/Cron セッションにはより狭い許可リストが適用されます（`AGENTS.md`、`TOOLS.md`、`SOUL.md`、`IDENTITY.md`、`USER.md`）。

**有効化**：

```bash
openclaw hooks enable bootstrap-extra-files
```

### command-logger

すべてのコマンドイベントを中央監査ファイルにログ記録します。

**イベント**：`command`

**要件**：なし

**出力**：`~/.openclaw/logs/commands.log`

**何をするか**：

1. イベント詳細（コマンドアクション、タイムスタンプ、セッションキー、送信者 ID、ソース）をキャプチャする
2. JSONL フォーマットでログファイルに追記する
3. バックグラウンドで静かに実行する

**ログエントリ例**：

```jsonl
{"timestamp":"2026-01-16T14:30:00.000Z","action":"new","sessionKey":"agent:main:main","senderId":"+1234567890","source":"telegram"}
{"timestamp":"2026-01-16T15:45:22.000Z","action":"stop","sessionKey":"agent:main:main","senderId":"user@example.com","source":"whatsapp"}
```

**ログの表示**：

```bash
# 最近のコマンドを表示
tail -n 20 ~/.openclaw/logs/commands.log

# jq で整形表示
cat ~/.openclaw/logs/commands.log | jq .

# アクションでフィルタリング
grep '"action":"new"' ~/.openclaw/logs/commands.log | jq .
```

**有効化**：

```bash
openclaw hooks enable command-logger
```

### boot-md

Gateway ゲートウェイ起動時（チャンネル起動後）に `BOOT.md` を実行します。
これを実行するには内部フックが有効である必要があります。

**イベント**：`gateway:startup`

**要件**：`workspace.dir` が設定されている必要あり

**何をするか**：

1. ワークスペースから `BOOT.md` を読み込む
2. エージェントランナーを介して指示を実行する
3. メッセージツールを介してリクエストされたアウトバウンドメッセージを送信する

**有効化**：

```bash
openclaw hooks enable boot-md
```

## ベストプラクティス

### ハンドラーを高速に保つ

フックはコマンド処理中に実行されます。軽量に保ってください：

```typescript
// ✓ 良い - 非同期作業、即座に返す
const handler: HookHandler = async (event) => {
  void processInBackground(event); // ファイアアンドフォーゲット
};

// ✗ 悪い - コマンド処理をブロックする
const handler: HookHandler = async (event) => {
  await slowDatabaseQuery(event);
  await evenSlowerAPICall(event);
};
```

### エラーを適切に処理する

リスクのある操作は常にラップしてください：

```typescript
const handler: HookHandler = async (event) => {
  try {
    await riskyOperation(event);
  } catch (err) {
    console.error("[my-handler] Failed:", err instanceof Error ? err.message : String(err));
    // スローしない - 他のハンドラーを実行させる
  }
};
```

### 早めにイベントをフィルタリングする

イベントが関連しない場合は早期にリターンしてください：

```typescript
const handler: HookHandler = async (event) => {
  // 'new' コマンドのみ処理
  if (event.type !== "command" || event.action !== "new") {
    return;
  }

  // ロジックはここに
};
```

### 特定のイベントキーを使用する

可能であればメタデータで正確なイベントを指定してください：

```yaml
metadata: { "openclaw": { "events": ["command:new"] } } # 特定
```

次のようなものではなく：

```yaml
metadata: { "openclaw": { "events": ["command"] } } # 一般 - オーバーヘッドが多い
```

## デバッグ

### フックロギングを有効にする

Gateway ゲートウェイは起動時にフックのロードをログに記録します：

```text
Registered hook: session-memory -> command:new, command:reset
Registered hook: bootstrap-extra-files -> agent:bootstrap
Registered hook: command-logger -> command
Registered hook: boot-md -> gateway:startup
```

### 検出を確認する

検出されたすべてのフックを一覧表示：

```bash
openclaw hooks list --verbose
```

### 登録を確認する

ハンドラーで呼び出されたときにログを記録：

```typescript
const handler: HookHandler = async (event) => {
  console.log("[my-handler] Triggered:", event.type, event.action);
  // ロジック
};
```

### 適格性を確認する

フックが対象外になっている理由を確認：

```bash
openclaw hooks info my-hook
```

出力の不足している要件を確認してください。
