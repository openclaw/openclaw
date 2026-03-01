---
summary: "フック: コマンドとライフサイクルイベント向けのイベント駆動自動化"
read_when:
  - /new、/reset、/stop、エージェントライフサイクルイベントに対するイベント駆動自動化が必要なとき
  - フックのビルド、インストール、デバッグをするとき
title: "フック"
---

# フック

フックはエージェントコマンドとイベントに応じてアクションを自動化するための拡張可能なイベント駆動システムを提供します。フックはディレクトリから自動的に検出され、OpenClaw でのスキルの動作と同様に CLI コマンドで管理できます。

## 始め方

フックは何かが起こったときに実行される小さなスクリプトです。2 種類あります:

- **フック**（このページ）: `/new`、`/reset`、`/stop`、またはライフサイクルイベントのようなエージェントイベントが発生したときに Gateway 内で実行されます。
- **Webhook**: 外部システムが OpenClaw でのアクションをトリガーできる外部 HTTP Webhook。[Webhook フック](/automation/webhook) を参照するか、Gmail ヘルパーコマンドに `openclaw webhooks` を使用してください。

フックはプラグイン内にバンドルすることもできます。[プラグイン](/tools/plugin#plugin-hooks) を参照してください。

一般的な用途:

- セッションをリセットするときにメモリスナップショットを保存する
- トラブルシューティングやコンプライアンスのためにコマンドの監査証跡を保持する
- セッションが開始または終了したときにフォローアップの自動化をトリガーする
- イベントが発生したときにエージェントワークスペースにファイルを書き込んだり外部 API を呼び出したりする

小さな TypeScript 関数を書けるなら、フックを書けます。フックは自動的に検出され、CLI で有効または無効にできます。

## 概要

フックシステムでは以下が可能です:

- `/new` が発行されたときにセッションコンテキストをメモリに保存する
- 監査のためにすべてのコマンドをログに記録する
- エージェントライフサイクルイベントでカスタム自動化をトリガーする
- コアコードを変更せずに OpenClaw の動作を拡張する

## はじめに

### バンドルフック

OpenClaw には自動的に検出される 4 つのバンドルフックが付属しています:

- **💾 session-memory**: `/new` を発行したときにセッションコンテキストをエージェントワークスペース（デフォルト `~/.openclaw/workspace/memory/`）に保存します
- **📎 bootstrap-extra-files**: `agent:bootstrap` 中に設定されたグロブ/パスパターンから追加のワークスペースブートストラップファイルを挿入します
- **📝 command-logger**: すべてのコマンドイベントを `~/.openclaw/logs/commands.log` に記録します
- **🚀 boot-md**: Gateway が起動したときに `BOOT.md` を実行します（内部フックが有効である必要があります）

利用可能なフックを一覧表示する:

```bash
openclaw hooks list
```

フックを有効にする:

```bash
openclaw hooks enable session-memory
```

フックのステータスを確認する:

```bash
openclaw hooks check
```

詳細情報を取得する:

```bash
openclaw hooks info session-memory
```

### オンボーディング

オンボーディング中（`openclaw onboard`）、推奨フックを有効にするかどうか確認されます。ウィザードは対象のフックを自動的に検出して選択肢として提示します。

## フックの検出

フックは 3 つのディレクトリから自動的に検出されます（優先度順）:

1. **ワークスペースフック**: `<workspace>/hooks/`（エージェントごと、最高優先度）
2. **マネージドフック**: `~/.openclaw/hooks/`（ユーザーインストール、ワークスペース間で共有）
3. **バンドルフック**: `<openclaw>/dist/hooks/bundled/`（OpenClaw に同梱）

マネージドフックディレクトリは**単一のフック**または**フックパック**（パッケージディレクトリ）のどちらかです。

各フックは以下を含むディレクトリです:

```
my-hook/
├── HOOK.md          # メタデータ + ドキュメント
└── handler.ts       # ハンドラー実装
```

## フックパック（npm/アーカイブ）

フックパックは `package.json` の `openclaw.hooks` を通じて 1 つ以上のフックをエクスポートする標準の npm パッケージです。以下でインストールします:

```bash
openclaw hooks install <path-or-spec>
```

npm スペックはレジストリのみです（パッケージ名 + オプションのバージョン/タグ）。Git/URL/ファイルのスペックは拒否されます。

`package.json` の例:

```json
{
  "name": "@acme/my-hooks",
  "version": "0.1.0",
  "openclaw": {
    "hooks": ["./hooks/my-hook", "./hooks/other-hook"]
  }
}
```

各エントリは `HOOK.md` と `handler.ts`（または `index.ts`）を含むフックディレクトリを指します。フックパックは依存関係を含めることができます。依存関係は `~/.openclaw/hooks/<id>` にインストールされます。各 `openclaw.hooks` エントリはシンボリックリンク解決後もパッケージディレクトリ内に留まる必要があります。エスケープするエントリは拒否されます。

セキュリティの注意: `openclaw hooks install` は `npm install --ignore-scripts` で依存関係をインストールします（ライフサイクルスクリプトなし）。フックパックの依存関係ツリーを「純粋な JS/TS」に保ち、`postinstall` ビルドに依存するパッケージを避けてください。

## フックの構造

### HOOK.md フォーマット

`HOOK.md` ファイルには YAML フロントマターに加えて Markdown ドキュメントが含まれます:

```markdown
---
name: my-hook
description: "このフックが何をするかの短い説明"
homepage: https://docs.openclaw.ai/automation/hooks#my-hook
metadata:
  { "openclaw": { "emoji": "🔗", "events": ["command:new"], "requires": { "bins": ["node"] } } }
---

# My Hook

詳細なドキュメントをここに...

## 何をするか

- `/new` コマンドをリッスンする
- 何かのアクションを実行する
- 結果をログに記録する

## 要件

- Node.js がインストールされていること

## 設定

設定は不要です。
```

### メタデータフィールド

`metadata.openclaw` オブジェクトがサポートするフィールド:

- **`emoji`**: CLI 用の表示絵文字（例: `"💾"`）
- **`events`**: リッスンするイベントの配列（例: `["command:new", "command:reset"]`）
- **`export`**: 使用する名前付きエクスポート（デフォルト: `"default"`）
- **`homepage`**: ドキュメント URL
- **`requires`**: オプションの要件
  - **`bins`**: PATH 上で必要なバイナリ（例: `["git", "node"]`）
  - **`anyBins`**: これらのバイナリのうち少なくとも1つが存在する必要があります
  - **`env`**: 必要な環境変数
  - **`config`**: 必要な設定パス（例: `["workspace.dir"]`）
  - **`os`**: 必要なプラットフォーム（例: `["darwin", "linux"]`）
- **`always`**: 適格性チェックをバイパスします（ブーリアン）
- **`install`**: インストール方法（バンドルフック: `[{"id":"bundled","kind":"bundled"}]`）

### ハンドラー実装

`handler.ts` ファイルは `HookHandler` 関数をエクスポートします:

```typescript
const myHandler = async (event) => {
  // 'new' コマンドのときのみトリガー
  if (event.type !== "command" || event.action !== "new") {
    return;
  }

  console.log(`[my-hook] New command triggered`);
  console.log(`  Session: ${event.sessionKey}`);
  console.log(`  Timestamp: ${event.timestamp.toISOString()}`);

  // カスタムロジックをここに

  // オプションでユーザーにメッセージを送信
  event.messages.push("✨ My hook executed!");
};

export default myHandler;
```

#### イベントコンテキスト

各イベントには以下が含まれます:

```typescript
{
  type: 'command' | 'session' | 'agent' | 'gateway' | 'message',
  action: string,              // 例: 'new', 'reset', 'stop', 'received', 'sent'
  sessionKey: string,          // セッション識別子
  timestamp: Date,             // イベント発生時刻
  messages: string[],          // ここにメッセージをプッシュしてユーザーに送信
  context: {
    // コマンドイベント:
    sessionEntry?: SessionEntry,
    sessionId?: string,
    sessionFile?: string,
    commandSource?: string,    // 例: 'whatsapp', 'telegram'
    senderId?: string,
    workspaceDir?: string,
    bootstrapFiles?: WorkspaceBootstrapFile[],
    cfg?: OpenClawConfig,
    // メッセージイベント（完全な詳細はメッセージイベントのセクションを参照）:
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

エージェントコマンドが発行されたときにトリガーされます:

- **`command`**: すべてのコマンドイベント（汎用リスナー）
- **`command:new`**: `/new` コマンドが発行されたとき
- **`command:reset`**: `/reset` コマンドが発行されたとき
- **`command:stop`**: `/stop` コマンドが発行されたとき

### エージェントイベント

- **`agent:bootstrap`**: ワークスペースブートストラップファイルが挿入される前（フックは `context.bootstrapFiles` を変更できます）

### Gateway イベント

Gateway が起動したときにトリガーされます:

- **`gateway:startup`**: チャンネルが起動してフックが読み込まれた後

### メッセージイベント

メッセージが受信または送信されたときにトリガーされます:

- **`message`**: すべてのメッセージイベント（汎用リスナー）
- **`message:received`**: 任意のチャンネルからのインバウンドメッセージが受信されたとき
- **`message:sent`**: アウトバウンドメッセージが正常に送信されたとき

#### メッセージイベントコンテキスト

メッセージイベントにはメッセージに関するリッチなコンテキストが含まれます:

```typescript
// message:received コンテキスト
{
  from: string,           // 送信者識別子（電話番号、ユーザー ID など）
  content: string,        // メッセージコンテンツ
  timestamp?: number,     // 受信時の Unix タイムスタンプ
  channelId: string,      // チャンネル（例: "whatsapp", "telegram", "discord"）
  accountId?: string,     // マルチアカウント設定のプロバイダーアカウント ID
  conversationId?: string, // チャット/会話 ID
  messageId?: string,     // プロバイダーからのメッセージ ID
  metadata?: {            // 追加のプロバイダー固有データ
    to?: string,
    provider?: string,
    surface?: string,
    threadId?: string,
    senderId?: string,
    senderName?: string,
    senderUsername?: string,
    senderE164?: string,
  }
}

// message:sent コンテキスト
{
  to: string,             // 受信者識別子
  content: string,        // 送信されたメッセージコンテンツ
  success: boolean,       // 送信が成功したかどうか
  error?: string,         // 送信に失敗した場合のエラーメッセージ
  channelId: string,      // チャンネル（例: "whatsapp", "telegram", "discord"）
  accountId?: string,     // プロバイダーアカウント ID
  conversationId?: string, // チャット/会話 ID
  messageId?: string,     // プロバイダーから返されたメッセージ ID
}
```

#### 例: メッセージロガーフック

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

これらのフックはイベントストリームリスナーではありません。プラグインがツール結果を OpenClaw が永続化する前に同期的に調整できるようにします。

- **`tool_result_persist`**: ツール結果がセッショントランスクリプトに書き込まれる前に変換します。同期的である必要があります。更新されたツール結果ペイロードを返すか、そのままにする場合は `undefined` を返します。[エージェントループ](/concepts/agent-loop) を参照してください。

### 将来のイベント

計画中のイベントタイプ:

- **`session:start`**: 新しいセッションが開始されたとき
- **`session:end`**: セッションが終了したとき
- **`agent:error`**: エージェントがエラーに遭遇したとき

## カスタムフックの作成

### 1. 場所を選ぶ

- **ワークスペースフック**（`<workspace>/hooks/`）: エージェントごと、最高優先度
- **マネージドフック**（`~/.openclaw/hooks/`）: ワークスペース間で共有

### 2. ディレクトリ構造を作成する

```bash
mkdir -p ~/.openclaw/hooks/my-hook
cd ~/.openclaw/hooks/my-hook
```

### 3. HOOK.md を作成する

```markdown
---
name: my-hook
description: "何か便利なことをする"
metadata: { "openclaw": { "emoji": "🎯", "events": ["command:new"] } }
---

# My Custom Hook

このフックは `/new` を発行したときに何か便利なことをします。
```

### 4. handler.ts を作成する

```typescript
const handler = async (event) => {
  if (event.type !== "command" || event.action !== "new") {
    return;
  }

  console.log("[my-hook] Running!");
  // ロジックをここに
};

export default handler;
```

### 5. 有効化してテストする

```bash
# フックが検出されていることを確認
openclaw hooks list

# 有効にする
openclaw hooks enable my-hook

# Gateway プロセスを再起動（macOS ではメニューバーアプリを再起動するか、開発プロセスを再起動）

# イベントをトリガーする
# メッセージングチャンネル経由で /new を送信
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

フックにはカスタム設定を持たせることができます:

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

追加ディレクトリからフックを読み込む:

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

旧設定フォーマットは後方互換性のために引き続き動作します:

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

注意: `module` はワークスペース相対パスである必要があります。絶対パスとワークスペース外のトラバーサルは拒否されます。

**移行**: 新しいフックには新しい検出ベースのシステムを使用してください。レガシーハンドラーはディレクトリベースのフックの後に読み込まれます。

## CLI コマンド

### フックを一覧表示する

```bash
# すべてのフックを一覧表示
openclaw hooks list

# 対象フックのみ表示
openclaw hooks list --eligible

# 詳細出力（欠落している要件を表示）
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

### 適格性を確認する

```bash
# 適格性のサマリーを表示
openclaw hooks check

# JSON 出力
openclaw hooks check --json
```

### 有効/無効にする

```bash
# フックを有効にする
openclaw hooks enable session-memory

# フックを無効にする
openclaw hooks disable command-logger
```

## バンドルフックリファレンス

### session-memory

`/new` を発行したときにセッションコンテキストをメモリに保存します。

**イベント**: `command:new`

**要件**: `workspace.dir` が設定されていること

**出力**: `<workspace>/memory/YYYY-MM-DD-slug.md`（デフォルト: `~/.openclaw/workspace`）

**何をするか**:

1. リセット前のセッションエントリを使用して正しいトランスクリプトを特定します
2. 会話の最後の 15 行を抽出します
3. LLM を使用して説明的なファイル名スラッグを生成します
4. セッションメタデータを日付付きメモリファイルに保存します

**出力例**:

```markdown
# Session: 2026-01-16 14:30:00 UTC

- **Session Key**: agent:main:main
- **Session ID**: abc123def456
- **Source**: telegram
```

**ファイル名の例**:

- `2026-01-16-vendor-pitch.md`
- `2026-01-16-api-design.md`
- `2026-01-16-1430.md`（スラッグ生成に失敗した場合のフォールバックタイムスタンプ）

**有効にする**:

```bash
openclaw hooks enable session-memory
```

### bootstrap-extra-files

`agent:bootstrap` 中に追加のブートストラップファイル（例えばモノレポローカルの `AGENTS.md` / `TOOLS.md`）を挿入します。

**イベント**: `agent:bootstrap`

**要件**: `workspace.dir` が設定されていること

**出力**: ファイルは書き込まれません。ブートストラップコンテキストはメモリ内でのみ変更されます。

**設定**:

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

**注意**:

- パスはワークスペース相対で解決されます。
- ファイルはワークスペース内に留まる必要があります（realpath チェック）。
- 認識されたブートストラップベース名のみが読み込まれます。
- サブエージェント許可リストが保持されます（`AGENTS.md` と `TOOLS.md` のみ）。

**有効にする**:

```bash
openclaw hooks enable bootstrap-extra-files
```

### command-logger

すべてのコマンドイベントを集中監査ファイルに記録します。

**イベント**: `command`

**要件**: なし

**出力**: `~/.openclaw/logs/commands.log`

**何をするか**:

1. イベントの詳細（コマンドアクション、タイムスタンプ、セッションキー、送信者 ID、ソース）をキャプチャします
2. JSONL 形式でログファイルに追記します
3. バックグラウンドで静かに実行されます

**ログエントリの例**:

```jsonl
{"timestamp":"2026-01-16T14:30:00.000Z","action":"new","sessionKey":"agent:main:main","senderId":"+1234567890","source":"telegram"}
{"timestamp":"2026-01-16T15:45:22.000Z","action":"stop","sessionKey":"agent:main:main","senderId":"user@example.com","source":"whatsapp"}
```

**ログを表示する**:

```bash
# 最近のコマンドを表示
tail -n 20 ~/.openclaw/logs/commands.log

# jq で整形表示
cat ~/.openclaw/logs/commands.log | jq .

# アクションでフィルター
grep '"action":"new"' ~/.openclaw/logs/commands.log | jq .
```

**有効にする**:

```bash
openclaw hooks enable command-logger
```

### boot-md

Gateway が起動したとき（チャンネルが起動した後）に `BOOT.md` を実行します。これを実行するには内部フックが有効である必要があります。

**イベント**: `gateway:startup`

**要件**: `workspace.dir` が設定されていること

**何をするか**:

1. ワークスペースから `BOOT.md` を読み込みます
2. エージェントランナーを通じて指示を実行します
3. メッセージツールを通じてリクエストされたアウトバウンドメッセージを送信します

**有効にする**:

```bash
openclaw hooks enable boot-md
```

## ベストプラクティス

### ハンドラーを高速に保つ

フックはコマンド処理中に実行されます。軽量に保ってください:

```typescript
// ✓ 良い例 - 非同期作業、すぐに返す
const handler: HookHandler = async (event) => {
  void processInBackground(event); // ファイアアンドフォーゲット
};

// ✗ 悪い例 - コマンド処理をブロックする
const handler: HookHandler = async (event) => {
  await slowDatabaseQuery(event);
  await evenSlowerAPICall(event);
};
```

### エラーを適切に処理する

リスクのある操作は必ずラップしてください:

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

関連するイベントでない場合は早めに返します:

```typescript
const handler: HookHandler = async (event) => {
  // 'new' コマンドのみを処理
  if (event.type !== "command" || event.action !== "new") {
    return;
  }

  // ロジックをここに
};
```

### 特定のイベントキーを使用する

可能であればメタデータに正確なイベントを指定してください:

```yaml
metadata: { "openclaw": { "events": ["command:new"] } } # 特定的
```

以下の代わりに:

```yaml
metadata: { "openclaw": { "events": ["command"] } } # 汎用的 - より多くのオーバーヘッド
```

## デバッグ

### フックログを有効にする

Gateway は起動時にフックの読み込みをログに記録します:

```
Registered hook: session-memory -> command:new
Registered hook: bootstrap-extra-files -> agent:bootstrap
Registered hook: command-logger -> command
Registered hook: boot-md -> gateway:startup
```

### 検出を確認する

検出されたすべてのフックを一覧表示します:

```bash
openclaw hooks list --verbose
```

### 登録を確認する

ハンドラーで呼び出されたときにログを記録します:

```typescript
const handler: HookHandler = async (event) => {
  console.log("[my-handler] Triggered:", event.type, event.action);
  // ロジック
};
```

### 適格性を確認する

フックが対象でない理由を確認します:

```bash
openclaw hooks info my-hook
```

出力で欠落している要件を探してください。

## テスト

### Gateway ログ

Gateway ログを監視してフック実行を確認します:

```bash
# macOS
./scripts/clawlog.sh -f

# 他のプラットフォーム
tail -f ~/.openclaw/gateway.log
```

### フックを直接テストする

ハンドラーを単独でテストします:

```typescript
import { test } from "vitest";
import myHandler from "./hooks/my-hook/handler.js";

test("my handler works", async () => {
  const event = {
    type: "command",
    action: "new",
    sessionKey: "test-session",
    timestamp: new Date(),
    messages: [],
    context: { foo: "bar" },
  };

  await myHandler(event);

  // 副作用をアサート
});
```

## アーキテクチャ

### コアコンポーネント

- **`src/hooks/types.ts`**: 型定義
- **`src/hooks/workspace.ts`**: ディレクトリスキャンと読み込み
- **`src/hooks/frontmatter.ts`**: HOOK.md メタデータのパース
- **`src/hooks/config.ts`**: 適格性チェック
- **`src/hooks/hooks-status.ts`**: ステータスレポート
- **`src/hooks/loader.ts`**: 動的モジュールローダー
- **`src/cli/hooks-cli.ts`**: CLI コマンド
- **`src/gateway/server-startup.ts`**: Gateway 起動時にフックを読み込む
- **`src/auto-reply/reply/commands-core.ts`**: コマンドイベントをトリガーする

### 検出フロー

```
Gateway 起動
    ↓
ディレクトリをスキャン（ワークスペース → マネージド → バンドル）
    ↓
HOOK.md ファイルをパース
    ↓
適格性をチェック（bins, env, config, os）
    ↓
対象フックからハンドラーを読み込む
    ↓
イベントにハンドラーを登録する
```

### イベントフロー

```
ユーザーが /new を送信
    ↓
コマンドの検証
    ↓
フックイベントを作成
    ↓
フックをトリガー（登録済みハンドラーすべて）
    ↓
コマンド処理が続く
    ↓
セッションリセット
```

## トラブルシューティング

### フックが検出されない

1. ディレクトリ構造を確認:

   ```bash
   ls -la ~/.openclaw/hooks/my-hook/
   # 表示されるべき: HOOK.md, handler.ts
   ```

2. HOOK.md フォーマットを確認:

   ```bash
   cat ~/.openclaw/hooks/my-hook/HOOK.md
   # 名前とメタデータを含む YAML フロントマターがあるべき
   ```

3. 検出されたすべてのフックを一覧表示:

   ```bash
   openclaw hooks list
   ```

### フックが対象でない

要件を確認します:

```bash
openclaw hooks info my-hook
```

欠落しているものを探します:

- バイナリ（PATH を確認）
- 環境変数
- 設定値
- OS 互換性

### フックが実行されない

1. フックが有効になっているか確認:

   ```bash
   openclaw hooks list
   # 有効なフックの横に ✓ が表示されるべき
   ```

2. フックが再読み込みされるように Gateway プロセスを再起動します。

3. エラーの Gateway ログを確認:

   ```bash
   ./scripts/clawlog.sh | grep hook
   ```

### ハンドラーエラー

TypeScript/インポートエラーを確認します:

```bash
# インポートを直接テスト
node -e "import('./path/to/handler.ts').then(console.log)"
```

## 移行ガイド

### レガシー設定から検出ベースへ

**移行前**:

```json
{
  "hooks": {
    "internal": {
      "enabled": true,
      "handlers": [
        {
          "event": "command:new",
          "module": "./hooks/handlers/my-handler.ts"
        }
      ]
    }
  }
}
```

**移行後**:

1. フックディレクトリを作成:

   ```bash
   mkdir -p ~/.openclaw/hooks/my-hook
   mv ./hooks/handlers/my-handler.ts ~/.openclaw/hooks/my-hook/handler.ts
   ```

2. HOOK.md を作成:

   ```markdown
   ---
   name: my-hook
   description: "My custom hook"
   metadata: { "openclaw": { "emoji": "🎯", "events": ["command:new"] } }
   ---

   # My Hook

   何か便利なことをします。
   ```

3. 設定を更新:

   ```json
   {
     "hooks": {
       "internal": {
         "enabled": true,
         "entries": {
           "my-hook": { "enabled": true }
         }
       }
     }
   }
   ```

4. 確認して Gateway プロセスを再起動:

   ```bash
   openclaw hooks list
   # 表示されるべき: 🎯 my-hook ✓
   ```

**移行の利点**:

- 自動検出
- CLI 管理
- 適格性チェック
- より良いドキュメント
- 一貫した構造

## 関連リンク

- [CLI リファレンス: フック](/cli/hooks)
- [バンドルフック README](https://github.com/openclaw/openclaw/tree/main/src/hooks/bundled)
- [Webhook フック](/automation/webhook)
- [設定](/gateway/configuration#hooks)
