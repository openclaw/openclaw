---
title: "Pi インテグレーションアーキテクチャ"
summary: "OpenClaw の組み込み Pi エージェントインテグレーションとセッションライフサイクルのアーキテクチャ"
read_when:
  - OpenClaw での Pi SDK インテグレーション設計を理解する場合
  - Pi のエージェントセッションライフサイクル、ツール、またはプロバイダー配線を変更する場合
---

# Pi インテグレーションアーキテクチャ

このドキュメントは、OpenClaw が [pi-coding-agent](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent) とその兄弟パッケージ（`pi-ai`、`pi-agent-core`、`pi-tui`）を統合して AI エージェント機能を実現する方法を説明します。

## 概要

OpenClaw は Pi SDK を使用して、AI コーディングエージェントをメッセージングゲートウェイアーキテクチャに埋め込みます。Pi をサブプロセスとして起動したり RPC モードを使用したりする代わりに、OpenClaw は `createAgentSession()` を介して Pi の `AgentSession` を直接インポートしてインスタンス化します。この組み込みアプローチにより以下が可能になります:

- セッションライフサイクルとイベント処理の完全な制御
- カスタムツールの注入（メッセージング、サンドボックス、チャンネル固有のアクション）
- チャンネル/コンテキストごとのシステムプロンプトのカスタマイズ
- ブランチ/コンパクションサポート付きのセッション永続化
- フェイルオーバー付きのマルチアカウント認証プロファイルローテーション
- プロバイダー非依存のモデル切り替え

## パッケージの依存関係

```json
{
  "@mariozechner/pi-agent-core": "0.49.3",
  "@mariozechner/pi-ai": "0.49.3",
  "@mariozechner/pi-coding-agent": "0.49.3",
  "@mariozechner/pi-tui": "0.49.3"
}
```

| パッケージ        | 目的                                                                                                   |
| ----------------- | ------------------------------------------------------------------------------------------------------ |
| `pi-ai`           | コア LLM 抽象化: `Model`、`streamSimple`、メッセージタイプ、プロバイダー API                           |
| `pi-agent-core`   | エージェントループ、ツール実行、`AgentMessage` タイプ                                                  |
| `pi-coding-agent` | 高レベル SDK: `createAgentSession`、`SessionManager`、`AuthStorage`、`ModelRegistry`、組み込みツール |
| `pi-tui`          | ターミナル UI コンポーネント（OpenClaw のローカル TUI モードで使用）                                   |

## ファイル構造

```
src/agents/
├── pi-embedded-runner.ts          # pi-embedded-runner/ からの再エクスポート
├── pi-embedded-runner/
│   ├── run.ts                     # メインエントリー: runEmbeddedPiAgent()
│   ├── run/
│   │   ├── attempt.ts             # セッション設定付き単一試行ロジック
│   │   ├── params.ts              # RunEmbeddedPiAgentParams タイプ
│   │   ├── payloads.ts            # 実行結果からレスポンスペイロードを構築
│   │   ├── images.ts              # ビジョンモデル画像注入
│   │   └── types.ts               # EmbeddedRunAttemptResult
│   ├── abort.ts                   # 中断エラー検出
│   ├── cache-ttl.ts               # コンテキスト刈り込み用キャッシュ TTL 追跡
│   ├── compact.ts                 # 手動/自動コンパクションロジック
│   ├── extensions.ts              # 組み込み実行用 Pi 拡張機能のロード
│   ├── extra-params.ts            # プロバイダー固有のストリームパラメータ
│   ├── google.ts                  # Google/Gemini ターン順序修正
│   ├── history.ts                 # 履歴制限（DM vs グループ）
│   ├── lanes.ts                   # セッション/グローバルコマンドレーン
│   ├── logger.ts                  # サブシステムロガー
│   ├── model.ts                   # ModelRegistry 経由のモデル解決
│   ├── runs.ts                    # アクティブ実行追跡、中断、キュー
│   ├── sandbox-info.ts            # システムプロンプト用サンドボックス情報
│   ├── session-manager-cache.ts   # SessionManager インスタンスキャッシュ
│   ├── session-manager-init.ts    # セッションファイル初期化
│   ├── system-prompt.ts           # システムプロンプトビルダー
│   ├── tool-split.ts              # ツールを builtIn vs custom に分割
│   ├── types.ts                   # EmbeddedPiAgentMeta、EmbeddedPiRunResult
│   └── utils.ts                   # ThinkLevel マッピング、エラー説明
├── pi-embedded-subscribe.ts       # セッションイベントのサブスクリプション/ディスパッチ
├── pi-embedded-subscribe.types.ts # SubscribeEmbeddedPiSessionParams
├── pi-embedded-subscribe.handlers.ts # イベントハンドラーファクトリー
├── pi-embedded-subscribe.handlers.lifecycle.ts
├── pi-embedded-subscribe.handlers.types.ts
├── pi-embedded-block-chunker.ts   # ストリーミングブロック返信チャンキング
├── pi-embedded-messaging.ts       # メッセージングツール送信追跡
├── pi-embedded-helpers.ts         # エラー分類、ターン検証
├── pi-embedded-helpers/           # ヘルパーモジュール
├── pi-embedded-utils.ts           # フォーマットユーティリティ
├── pi-tools.ts                    # createOpenClawCodingTools()
├── pi-tools.abort.ts              # ツール用 AbortSignal ラッピング
├── pi-tools.policy.ts             # ツールアローリスト/デニーリストポリシー
├── pi-tools.read.ts               # 読み取りツールのカスタマイズ
├── pi-tools.schema.ts             # ツールスキーマの正規化
├── pi-tools.types.ts              # AnyAgentTool タイプエイリアス
├── pi-tool-definition-adapter.ts  # AgentTool -> ToolDefinition アダプター
├── pi-settings.ts                 # 設定のオーバーライド
├── pi-extensions/                 # カスタム Pi 拡張機能
│   ├── compaction-safeguard.ts    # セーフガード拡張機能
│   ├── compaction-safeguard-runtime.ts
│   ├── context-pruning.ts         # キャッシュ TTL コンテキスト刈り込み拡張機能
│   └── context-pruning/
├── model-auth.ts                  # 認証プロファイル解決
├── auth-profiles.ts               # プロファイルストア、クールダウン、フェイルオーバー
├── model-selection.ts             # デフォルトモデル解決
├── models-config.ts               # models.json 生成
├── model-catalog.ts               # モデルカタログキャッシュ
├── context-window-guard.ts        # コンテキストウィンドウ検証
├── failover-error.ts              # FailoverError クラス
├── defaults.ts                    # DEFAULT_PROVIDER、DEFAULT_MODEL
├── system-prompt.ts               # buildAgentSystemPrompt()
├── system-prompt-params.ts        # システムプロンプトパラメータ解決
├── system-prompt-report.ts        # デバッグレポート生成
├── tool-summaries.ts              # ツール説明サマリー
├── tool-policy.ts                 # ツールポリシー解決
├── transcript-policy.ts           # トランスクリプト検証ポリシー
├── skills.ts                      # スキルスナップショット/プロンプト構築
├── skills/                        # スキルサブシステム
├── sandbox.ts                     # サンドボックスコンテキスト解決
├── sandbox/                       # サンドボックスサブシステム
├── channel-tools.ts               # チャンネル固有のツール注入
├── openclaw-tools.ts              # OpenClaw 固有のツール
├── bash-tools.ts                  # exec/process ツール
├── apply-patch.ts                 # apply_patch ツール（OpenAI）
├── tools/                         # 個別ツール実装
│   ├── browser-tool.ts
│   ├── canvas-tool.ts
│   ├── cron-tool.ts
│   ├── discord-actions*.ts
│   ├── gateway-tool.ts
│   ├── image-tool.ts
│   ├── message-tool.ts
│   ├── nodes-tool.ts
│   ├── session*.ts
│   ├── slack-actions.ts
│   ├── telegram-actions.ts
│   ├── web-*.ts
│   └── whatsapp-actions.ts
└── ...
```

## コアインテグレーションフロー

### 1. 組み込みエージェントの実行

メインエントリーポイントは `pi-embedded-runner/run.ts` の `runEmbeddedPiAgent()` です:

```typescript
import { runEmbeddedPiAgent } from "./agents/pi-embedded-runner.js";

const result = await runEmbeddedPiAgent({
  sessionId: "user-123",
  sessionKey: "main:whatsapp:+1234567890",
  sessionFile: "/path/to/session.jsonl",
  workspaceDir: "/path/to/workspace",
  config: openclawConfig,
  prompt: "Hello, how are you?",
  provider: "anthropic",
  model: "claude-sonnet-4-20250514",
  timeoutMs: 120_000,
  runId: "run-abc",
  onBlockReply: async (payload) => {
    await sendToChannel(payload.text, payload.mediaUrls);
  },
});
```

### 2. セッション作成

`runEmbeddedAttempt()`（`runEmbeddedPiAgent()` から呼び出される）の内部で、Pi SDK が使用されます:

```typescript
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
} from "@mariozechner/pi-coding-agent";

const resourceLoader = new DefaultResourceLoader({
  cwd: resolvedWorkspace,
  agentDir,
  settingsManager,
  additionalExtensionPaths,
});
await resourceLoader.reload();

const { session } = await createAgentSession({
  cwd: resolvedWorkspace,
  agentDir,
  authStorage: params.authStorage,
  modelRegistry: params.modelRegistry,
  model: params.model,
  thinkingLevel: mapThinkingLevel(params.thinkLevel),
  tools: builtInTools,
  customTools: allCustomTools,
  sessionManager,
  settingsManager,
  resourceLoader,
});

applySystemPromptOverrideToSession(session, systemPromptOverride);
```

### 3. イベントサブスクリプション

`subscribeEmbeddedPiSession()` が Pi の `AgentSession` イベントをサブスクライブします:

```typescript
const subscription = subscribeEmbeddedPiSession({
  session: activeSession,
  runId: params.runId,
  verboseLevel: params.verboseLevel,
  reasoningMode: params.reasoningLevel,
  toolResultFormat: params.toolResultFormat,
  onToolResult: params.onToolResult,
  onReasoningStream: params.onReasoningStream,
  onBlockReply: params.onBlockReply,
  onPartialReply: params.onPartialReply,
  onAgentEvent: params.onAgentEvent,
});
```

処理されるイベントには以下が含まれます:

- `message_start` / `message_end` / `message_update`（ストリーミングテキスト/思考）
- `tool_execution_start` / `tool_execution_update` / `tool_execution_end`
- `turn_start` / `turn_end`
- `agent_start` / `agent_end`
- `auto_compaction_start` / `auto_compaction_end`

### 4. プロンプト

セットアップ後、セッションにプロンプトが送られます:

```typescript
await session.prompt(effectivePrompt, { images: imageResult.images });
```

SDK がフルエージェントループを処理します: LLM への送信、ツール呼び出しの実行、レスポンスのストリーミング。

画像注入はプロンプトローカルです: OpenClaw は現在のプロンプトから画像参照をロードし、そのターンのみのために `images` 経由で渡します。古い履歴ターンを再スキャンして画像ペイロードを再注入することはしません。

## ツールアーキテクチャ

### ツールパイプライン

1. **ベースツール**: Pi の `codingTools`（read、bash、edit、write）
2. **カスタム置き換え**: OpenClaw が bash を `exec`/`process` で置き換え、サンドボックス用に read/edit/write をカスタマイズ
3. **OpenClaw ツール**: メッセージング、ブラウザ、キャンバス、セッション、cron、Gateway など
4. **チャンネルツール**: Discord/Telegram/Slack/WhatsApp 固有のアクションツール
5. **ポリシーフィルタリング**: プロファイル、プロバイダー、エージェント、グループ、サンドボックスポリシーでフィルタリング
6. **スキーマ正規化**: Gemini/OpenAI の癖のためにスキーマをクリーンアップ
7. **AbortSignal ラッピング**: 中断シグナルを尊重するようにツールをラップ

### ツール定義アダプター

pi-agent-core の `AgentTool` は pi-coding-agent の `ToolDefinition` とは異なる `execute` シグネチャを持ちます。`pi-tool-definition-adapter.ts` のアダプターがこれをブリッジします:

```typescript
export function toToolDefinitions(tools: AnyAgentTool[]): ToolDefinition[] {
  return tools.map((tool) => ({
    name: tool.name,
    label: tool.label ?? name,
    description: tool.description ?? "",
    parameters: tool.parameters,
    execute: async (toolCallId, params, onUpdate, _ctx, signal) => {
      // pi-coding-agent のシグネチャは pi-agent-core と異なる
      return await tool.execute(toolCallId, params, signal, onUpdate);
    },
  }));
}
```

### ツール分割戦略

`splitSdkTools()` はすべてのツールを `customTools` 経由で渡します:

```typescript
export function splitSdkTools(options: { tools: AnyAgentTool[]; sandboxEnabled: boolean }) {
  return {
    builtInTools: [], // 空。すべてをオーバーライドします
    customTools: toToolDefinitions(options.tools),
  };
}
```

これにより、OpenClaw のポリシーフィルタリング、サンドボックスインテグレーション、拡張されたツールセットがプロバイダー間で一貫して維持されます。

## システムプロンプトの構築

システムプロンプトは `buildAgentSystemPrompt()`（`system-prompt.ts`）で構築されます。ツール、ツール呼び出しスタイル、安全ガードレール、OpenClaw CLI リファレンス、スキル、ドキュメント、ワークスペース、サンドボックス、メッセージング、返信タグ、音声、サイレント返信、ハートビート、ランタイムメタデータなどのセクションを含む完全なプロンプトを組み立てます。有効な場合はメモリとリアクション、オプションのコンテキストファイルと追加システムプロンプトコンテンツも含まれます。セクションはサブエージェントが使用する最小プロンプトモード用にトリムされます。

プロンプトはセッション作成後に `applySystemPromptOverrideToSession()` を介して適用されます:

```typescript
const systemPromptOverride = createSystemPromptOverride(appendPrompt);
applySystemPromptOverrideToSession(session, systemPromptOverride);
```

## セッション管理

### セッションファイル

セッションはツリー構造（id/parentId リンク）を持つ JSONL ファイルです。Pi の `SessionManager` が永続化を処理します:

```typescript
const sessionManager = SessionManager.open(params.sessionFile);
```

OpenClaw はツール結果の安全性のために `guardSessionManager()` でこれをラップします。

### セッションキャッシュ

`session-manager-cache.ts` は繰り返しのファイルパースを避けるために SessionManager インスタンスをキャッシュします:

```typescript
await prewarmSessionFile(params.sessionFile);
sessionManager = SessionManager.open(params.sessionFile);
trackSessionManagerAccess(params.sessionFile);
```

### 履歴制限

`limitHistoryTurns()` はチャンネルタイプ（DM vs グループ）に基づいて会話履歴をトリムします。

### コンパクション

コンテキストオーバーフロー時に自動コンパクションがトリガーされます。`compactEmbeddedPiSessionDirect()` が手動コンパクションを処理します:

```typescript
const compactResult = await compactEmbeddedPiSessionDirect({
  sessionId, sessionFile, provider, model, ...
});
```

## 認証とモデル解決

### 認証プロファイル

OpenClaw はプロバイダーごとに複数の API キーを持つ認証プロファイルストアを維持します:

```typescript
const authStore = ensureAuthProfileStore(agentDir, { allowKeychainPrompt: false });
const profileOrder = resolveAuthProfileOrder({ cfg, store: authStore, provider, preferredProfile });
```

プロファイルはクールダウン追跡付きで失敗時にローテーションします:

```typescript
await markAuthProfileFailure({ store, profileId, reason, cfg, agentDir });
const rotated = await advanceAuthProfile();
```

### モデル解決

```typescript
import { resolveModel } from "./pi-embedded-runner/model.js";

const { model, error, authStorage, modelRegistry } = resolveModel(
  provider,
  modelId,
  agentDir,
  config,
);

// Pi の ModelRegistry と AuthStorage を使用
authStorage.setRuntimeApiKey(model.provider, apiKeyInfo.apiKey);
```

### フェイルオーバー

`FailoverError` は設定されている場合にモデルフォールバックをトリガーします:

```typescript
if (fallbackConfigured && isFailoverErrorMessage(errorText)) {
  throw new FailoverError(errorText, {
    reason: promptFailoverReason ?? "unknown",
    provider,
    model: modelId,
    profileId,
    status: resolveFailoverStatus(promptFailoverReason),
  });
}
```

## Pi 拡張機能

OpenClaw は特殊な動作のためにカスタム Pi 拡張機能をロードします:

### コンパクションセーフガード

`src/agents/pi-extensions/compaction-safeguard.ts` はコンパクションにガードレールを追加し、適応型トークンバジェットとツール失敗およびファイル操作サマリーを含みます:

```typescript
if (resolveCompactionMode(params.cfg) === "safeguard") {
  setCompactionSafeguardRuntime(params.sessionManager, { maxHistoryShare });
  paths.push(resolvePiExtensionPath("compaction-safeguard"));
}
```

### コンテキスト刈り込み

`src/agents/pi-extensions/context-pruning.ts` はキャッシュ TTL ベースのコンテキスト刈り込みを実装します:

```typescript
if (cfg?.agents?.defaults?.contextPruning?.mode === "cache-ttl") {
  setContextPruningRuntime(params.sessionManager, {
    settings,
    contextWindowTokens,
    isToolPrunable,
    lastCacheTouchAt,
  });
  paths.push(resolvePiExtensionPath("context-pruning"));
}
```

## ストリーミングとブロック返信

### ブロックチャンキング

`EmbeddedBlockChunker` はストリーミングテキストを離散的な返信ブロックに管理します:

```typescript
const blockChunker = blockChunking ? new EmbeddedBlockChunker(blockChunking) : null;
```

### 思考/最終タグのストリッピング

ストリーミング出力は `<think>`/`<thinking>` ブロックを除去し、`<final>` コンテンツを抽出するために処理されます:

```typescript
const stripBlockTags = (text: string, state: { thinking: boolean; final: boolean }) => {
  // <think>...</think> コンテンツを除去
  // enforceFinalTag の場合、<final>...</final> コンテンツのみを返す
};
```

### 返信ディレクティブ

`[[media:url]]`、`[[voice]]`、`[[reply:id]]` のような返信ディレクティブがパースされて抽出されます:

```typescript
const { text: cleanedText, mediaUrls, audioAsVoice, replyToId } = consumeReplyDirectives(chunk);
```

## エラー処理

### エラー分類

`pi-embedded-helpers.ts` は適切な処理のためにエラーを分類します:

```typescript
isContextOverflowError(errorText)     // コンテキストが大きすぎる
isCompactionFailureError(errorText)   // コンパクション失敗
isAuthAssistantError(lastAssistant)   // 認証失敗
isRateLimitAssistantError(...)        // レート制限
isFailoverAssistantError(...)         // フェイルオーバーが必要
classifyFailoverReason(errorText)     // "auth" | "rate_limit" | "quota" | "timeout" | ...
```

### 思考レベルのフォールバック

思考レベルがサポートされていない場合、フォールバックします:

```typescript
const fallbackThinking = pickFallbackThinkingLevel({
  message: errorText,
  attempted: attemptedThinking,
});
if (fallbackThinking) {
  thinkLevel = fallbackThinking;
  continue;
}
```

## サンドボックスインテグレーション

サンドボックスモードが有効な場合、ツールとパスが制約されます:

```typescript
const sandbox = await resolveSandboxContext({
  config: params.config,
  sessionKey: sandboxSessionKey,
  workspaceDir: resolvedWorkspace,
});

if (sandboxRoot) {
  // サンドボックス化された read/edit/write ツールを使用
  // Exec はコンテナで実行
  // ブラウザはブリッジ URL を使用
}
```

## プロバイダー固有の処理

### Anthropic

- 拒否マジック文字列のスクラビング
- 連続ロールのターン検証
- Claude Code パラメータ互換性

### Google/Gemini

- ターン順序修正（`applyGoogleTurnOrderingFix`）
- ツールスキーマのサニタイズ（`sanitizeToolsForGoogle`）
- セッション履歴のサニタイズ（`sanitizeSessionHistory`）

### OpenAI

- Codex モデル用の `apply_patch` ツール
- 思考レベルのダウングレード処理

## TUI インテグレーション

OpenClaw には、pi-tui コンポーネントを直接使用するローカル TUI モードもあります:

```typescript
// src/tui/tui.ts
import { ... } from "@mariozechner/pi-tui";
```

これは Pi のネイティブモードに似たインタラクティブなターミナル体験を提供します。

## Pi CLI との主な違い

| 側面              | Pi CLI                  | OpenClaw 組み込み                                                                                                                                                               |
| ----------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 起動方法          | `pi` コマンド / RPC      | SDK 経由の `createAgentSession()`                                                                                                                                               |
| ツール            | デフォルトコーディングツール | カスタム OpenClaw ツールスイート                                                                                                                                                |
| システムプロンプト | AGENTS.md + プロンプト   | チャンネル/コンテキストごとの動的                                                                                                                                               |
| セッションストレージ | `~/.pi/agent/sessions/` | `~/.openclaw/agents/<agentId>/sessions/`（または `$OPENCLAW_STATE_DIR/agents/<agentId>/sessions/`）                                                                             |
| 認証              | 単一クレデンシャル       | ローテーション付きマルチプロファイル                                                                                                                                            |
| 拡張機能          | ディスクからロード       | プログラム + ディスクパス                                                                                                                                                       |
| イベント処理      | TUI レンダリング         | コールバックベース（onBlockReply など）                                                                                                                                         |

## 将来の検討事項

潜在的な再設計の分野:

1. **ツールシグネチャの整合**: 現在 pi-agent-core と pi-coding-agent のシグネチャ間でアダプティング中
2. **セッションマネージャーラッピング**: `guardSessionManager` が安全性を追加するが複雑さも増す
3. **拡張機能のロード**: Pi の `ResourceLoader` をより直接的に使用できる
4. **ストリーミングハンドラーの複雑さ**: `subscribeEmbeddedPiSession` が大きくなっている
5. **プロバイダー固有のコードパス**: Pi が処理できる可能性のある多くのプロバイダー固有コードパス

## テスト

Pi インテグレーションカバレッジは以下のスイートにわたります:

- `src/agents/pi-*.test.ts`
- `src/agents/pi-auth-json.test.ts`
- `src/agents/pi-embedded-*.test.ts`
- `src/agents/pi-embedded-helpers*.test.ts`
- `src/agents/pi-embedded-runner*.test.ts`
- `src/agents/pi-embedded-runner/**/*.test.ts`
- `src/agents/pi-embedded-subscribe*.test.ts`
- `src/agents/pi-tools*.test.ts`
- `src/agents/pi-tool-definition-adapter*.test.ts`
- `src/agents/pi-settings.test.ts`
- `src/agents/pi-extensions/**/*.test.ts`

ライブ/オプトイン:

- `src/agents/pi-embedded-runner-extraparams.live.test.ts`（`OPENCLAW_LIVE_TEST=1` で有効化）

現在の実行コマンドについては [Pi 開発ワークフロー](/pi-dev) を参照してください。
