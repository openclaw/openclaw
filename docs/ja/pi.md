---
title: "Pi 統合アーキテクチャ"
---

# Pi 統合アーキテクチャ

本ドキュメントでは、OpenClaw が [pi-coding-agent](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent) およびその兄弟パッケージ（`pi-ai`、`pi-agent-core`、`pi-tui`）とどのように統合され、AI エージェント機能を実現しているかを説明します。

## Overview

OpenClaw は pi SDK を使用して、AI コーディングエージェントをメッセージングゲートウェイアーキテクチャに組み込みます。pi をサブプロセスとして起動したり RPC モードを使用したりするのではなく、OpenClaw は `createAgentSession()` を介して pi の `AgentSession` を直接インポートおよびインスタンス化します。この組み込み型アプローチにより、次の利点が得られます。 パイをサブプロセスとしてスポーンさせる代わりに、またはRPCモードを使用する代わりに、OpenClawは`createAgentSession()`を介してpiの`AgentSession`を直接インポートしてインスタンス化します。 この組み込みアプローチは以下のとおりです。

- セッションライフサイクルおよびイベント処理を完全に制御
- カスタムツールの注入（メッセージング、サンドボックス、チャンネル固有アクション）
- チャンネル／コンテキストごとのシステムプロンプトのカスタマイズ
- 分岐／圧縮をサポートするセッション永続化
- フェイルオーバー付きのマルチアカウント認証プロファイルローテーション
- プロバイダー非依存のモデル切り替え

## Package Dependencies

```json
{
  "@mariozechner/pi-agent-core": "0.49.3",
  "@mariozechner/pi-ai": "0.49.3",
  "@mariozechner/pi-coding-agent": "0.49.3",
  "@mariozechner/pi-tui": "0.49.3"
}
```

| Package           | Purpose                                                                              |
| ----------------- | ------------------------------------------------------------------------------------ |
| `pi-ai`           | コア LLM 抽象化：`Model`、`streamSimple`、メッセージ型、プロバイダー API                                  |
| `pi-agent-core`   | エージェントループ、ツール実行、`AgentMessage` 型                                                     |
| `pi-coding-agent` | 高レベル SDK：`createAgentSession`、`SessionManager`、`AuthStorage`、`ModelRegistry`、組み込みツール |
| `pi-tui`          | ターミナル UI コンポーネント（OpenClaw のローカル TUI モードで使用）                                          |

## File Structure

```
src/agents/
├── pi-embedded-runner.ts          # Re-exports from pi-embedded-runner/
├── pi-embedded-runner/
│   ├── run.ts                     # Main entry: runEmbeddedPiAgent()
│   ├── run/
│   │   ├── attempt.ts             # Single attempt logic with session setup
│   │   ├── params.ts              # RunEmbeddedPiAgentParams type
│   │   ├── payloads.ts            # Build response payloads from run results
│   │   ├── images.ts              # Vision model image injection
│   │   └── types.ts               # EmbeddedRunAttemptResult
│   ├── abort.ts                   # Abort error detection
│   ├── cache-ttl.ts               # Cache TTL tracking for context pruning
│   ├── compact.ts                 # Manual/auto compaction logic
│   ├── extensions.ts              # Load pi extensions for embedded runs
│   ├── extra-params.ts            # Provider-specific stream params
│   ├── google.ts                  # Google/Gemini turn ordering fixes
│   ├── history.ts                 # History limiting (DM vs group)
│   ├── lanes.ts                   # Session/global command lanes
│   ├── logger.ts                  # Subsystem logger
│   ├── model.ts                   # Model resolution via ModelRegistry
│   ├── runs.ts                    # Active run tracking, abort, queue
│   ├── sandbox-info.ts            # Sandbox info for system prompt
│   ├── session-manager-cache.ts   # SessionManager instance caching
│   ├── session-manager-init.ts    # Session file initialization
│   ├── system-prompt.ts           # System prompt builder
│   ├── tool-split.ts              # Split tools into builtIn vs custom
│   ├── types.ts                   # EmbeddedPiAgentMeta, EmbeddedPiRunResult
│   └── utils.ts                   # ThinkLevel mapping, error description
├── pi-embedded-subscribe.ts       # Session event subscription/dispatch
├── pi-embedded-subscribe.types.ts # SubscribeEmbeddedPiSessionParams
├── pi-embedded-subscribe.handlers.ts # Event handler factory
├── pi-embedded-subscribe.handlers.lifecycle.ts
├── pi-embedded-subscribe.handlers.types.ts
├── pi-embedded-block-chunker.ts   # Streaming block reply chunking
├── pi-embedded-messaging.ts       # Messaging tool sent tracking
├── pi-embedded-helpers.ts         # Error classification, turn validation
├── pi-embedded-helpers/           # Helper modules
├── pi-embedded-utils.ts           # Formatting utilities
├── pi-tools.ts                    # createOpenClawCodingTools()
├── pi-tools.abort.ts              # AbortSignal wrapping for tools
├── pi-tools.policy.ts             # Tool allowlist/denylist policy
├── pi-tools.read.ts               # Read tool customizations
├── pi-tools.schema.ts             # Tool schema normalization
├── pi-tools.types.ts              # AnyAgentTool type alias
├── pi-tool-definition-adapter.ts  # AgentTool -> ToolDefinition adapter
├── pi-settings.ts                 # Settings overrides
├── pi-extensions/                 # Custom pi extensions
│   ├── compaction-safeguard.ts    # Safeguard extension
│   ├── compaction-safeguard-runtime.ts
│   ├── context-pruning.ts         # Cache-TTL context pruning extension
│   └── context-pruning/
├── model-auth.ts                  # Auth profile resolution
├── auth-profiles.ts               # Profile store, cooldown, failover
├── model-selection.ts             # Default model resolution
├── models-config.ts               # models.json generation
├── model-catalog.ts               # Model catalog cache
├── context-window-guard.ts        # Context window validation
├── failover-error.ts              # FailoverError class
├── defaults.ts                    # DEFAULT_PROVIDER, DEFAULT_MODEL
├── system-prompt.ts               # buildAgentSystemPrompt()
├── system-prompt-params.ts        # System prompt parameter resolution
├── system-prompt-report.ts        # Debug report generation
├── tool-summaries.ts              # Tool description summaries
├── tool-policy.ts                 # Tool policy resolution
├── transcript-policy.ts           # Transcript validation policy
├── skills.ts                      # Skill snapshot/prompt building
├── skills/                        # Skill subsystem
├── sandbox.ts                     # Sandbox context resolution
├── sandbox/                       # Sandbox subsystem
├── channel-tools.ts               # Channel-specific tool injection
├── openclaw-tools.ts              # OpenClaw-specific tools
├── bash-tools.ts                  # exec/process tools
├── apply-patch.ts                 # apply_patch tool (OpenAI)
├── tools/                         # Individual tool implementations
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

## Core Integration Flow

### 1. Running an Embedded Agent

メインのエントリーポイントは `pi-embedded-runner/run.ts` 内の `runEmbeddedPiAgent()` です。

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

### 2. Session Creation

`runEmbeddedPiAgent()` によって呼び出される `runEmbeddedAttempt()` の内部で、pi SDK が使用されます。

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

### 3. Event Subscription

`subscribeEmbeddedPiSession()` は、pi の `AgentSession` イベントを購読します。

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

処理されるイベントには次が含まれます。

- `message_start` / `message_end` / `message_update`（テキスト／思考のストリーミング）
- `tool_execution_start` / `tool_execution_update` / `tool_execution_end`
- `turn_start` / `turn_end`
- `agent_start` / `agent_end`
- `auto_compaction_start` / `auto_compaction_end`

### 4. Prompting

セットアップ後、セッションは次のようにプロンプトされます。

```typescript
await session.prompt(effectivePrompt, { images: imageResult.images });
```

SDK は、LLM への送信、ツール呼び出しの実行、レスポンスのストリーミングを含む完全なエージェントループを処理します。

## Tool Architecture

### Tool Pipeline

1. **Base Tools**：pi の `codingTools`（read、bash、edit、write）
2. **Custom Replacements**：OpenClaw は bash を `exec` / `process` に置き換え、サンドボックス用に read / edit / write をカスタマイズ
3. **OpenClaw Tools**：メッセージング、ブラウザ、キャンバス、セッション、cron、ゲートウェイなど
4. **Channel Tools**：Discord / Telegram / Slack / WhatsApp 固有のアクションツール
5. **Policy Filtering**：プロファイル、プロバイダー、エージェント、グループ、サンドボックスポリシーによるツールのフィルタリング
6. **Schema Normalization**：Gemini / OpenAI 固有の癖に対応するためのスキーマ整理
7. **AbortSignal Wrapping**：中断シグナルを尊重するためのツールラッピング

### Tool Definition Adapter

pi-agent-core の `AgentTool` は、pi-coding-agent の `ToolDefinition` とは異なる `execute` シグネチャを持ちます。`pi-tool-definition-adapter.ts` 内のアダプターがこれを橋渡しします。 `pi-tool-definition-adapter.ts`のアダプターは、以下のようにブリッジします。

```typescript
export function toToolDefinitions(tools: AnyAgentTool[]): ToolDefinition[] {
  return tools.map((tool) => ({
    name: tool.name,
    label: tool.label ?? name,
    description: tool.description ?? "",
    parameters: tool.parameters,
    execute: async (toolCallId, params, onUpdate, _ctx, signal) => {
      // pi-coding-agent signature differs from pi-agent-core
      return await tool.execute(toolCallId, params, signal, onUpdate);
    },
  }));
}
```

### Tool Split Strategy

`splitSdkTools()` は、すべてのツールを `customTools` 経由で渡します。

```typescript
export function splitSdkTools(options: { tools: AnyAgentTool[]; sandboxEnabled: boolean }) {
  return {
    builtInTools: [], // Empty. We override everything
    customTools: toToolDefinitions(options.tools),
  };
}
```

これにより、OpenClaw のポリシーフィルタリング、サンドボックス統合、拡張ツールセットが、すべてのプロバイダー間で一貫して維持されます。

## System Prompt Construction

システムプロンプトは `buildAgentSystemPrompt()`（`system-prompt.ts`）で構築されます。Tooling、Tool Call Style、安全性ガードレール、OpenClaw CLI リファレンス、Skills、Docs、Workspace、Sandbox、Messaging、Reply Tags、Voice、Silent Replies、Heartbeats、Runtime メタデータに加え、有効時には Memory と Reactions、さらにオプションのコンテキストファイルおよび追加のシステムプロンプト内容を含む完全なプロンプトを組み立てます。サブエージェントで使用される最小プロンプトモードでは、各セクションがトリミングされます。 ツール、ツールコールスタイル、安全ガードレール、OpenClawのCLI参照、スキル、ドキュメント、ワークスペース、サンドボックス、メッセージングなどのセクションで完全なプロンプトを組み立てます。 返信タグ、音声、サイレント返信、ハートビート、ランタイムメタデータ、プラスメモリとリアクション、オプションのコンテキストファイルと追加のシステムプロンプトコンテンツ。 サブエージェントで使用される最小限のプロンプトモードでは、セクションがトリミングされます。

このプロンプトは、セッション作成後に `applySystemPromptOverrideToSession()` を介して適用されます。

```typescript
const systemPromptOverride = createSystemPromptOverride(appendPrompt);
applySystemPromptOverrideToSession(session, systemPromptOverride);
```

## Session Management

### Session Files

セッションはツリー構造（id / parentId によるリンク）を持つ JSONL ファイルです。pi の `SessionManager` が永続化を処理します。 Pi の `SessionManager` ハンドル:

```typescript
const sessionManager = SessionManager.open(params.sessionFile);
```

OpenClaw は、ツール結果の安全性確保のためにこれを `guardSessionManager()` でラップします。

### Session Caching

`session-manager-cache.ts` は、ファイルの再解析を避けるために SessionManager インスタンスをキャッシュします。

```typescript
await prewarmSessionFile(params.sessionFile);
sessionManager = SessionManager.open(params.sessionFile);
trackSessionManagerAccess(params.sessionFile);
```

### History Limiting

`limitHistoryTurns()` は、チャンネル種別（ダイレクトメッセージ vs グループ）に基づいて会話履歴をトリミングします。

### Compaction

コンテキストオーバーフロー時に自動圧縮をトリガーします。 `compactEmbeddedPiSessionDirect()`は手動コンパクトを処理します。

```typescript
const compactResult = await compactEmbeddedPiSessionDirect({
  sessionId, sessionFile, provider, model, ...
});
```

## Authentication & Model Resolution

### Auth Profiles

OpenClaw は、プロバイダーごとに複数の API キーを持つ認証プロファイルストアを維持します。

```typescript
const authStore = ensureAuthProfileStore(agentDir, { allowKeychainPrompt: false });
const profileOrder = resolveAuthProfileOrder({ cfg, store: authStore, provider, preferredProfile });
```

プロファイルは、失敗時にクールダウントラッキング付きでローテーションされます。

```typescript
await markAuthProfileFailure({ store, profileId, reason, cfg, agentDir });
const rotated = await advanceAuthProfile();
```

### Model Resolution

```typescript
import { resolveModel } from "./pi-embedded-runner/model.js";

const { model, error, authStorage, modelRegistry } = resolveModel(
  provider,
  modelId,
  agentDir,
  config,
);

// Uses pi's ModelRegistry and AuthStorage
authStorage.setRuntimeApiKey(model.provider, apiKeyInfo.apiKey);
```

### Failover

`FailoverError` は、設定されている場合にモデルフォールバックをトリガーします。

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

## Pi Extensions

OpenClaw は、特殊な挙動のためにカスタム pi 拡張を読み込みます。

### Compaction Safeguard

`pi-extensions/compaction-safeguard.ts` は、適応的トークン予算編成に加え、ツール失敗およびファイル操作サマリーを含む圧縮ガードレールを追加します。

```typescript
if (resolveCompactionMode(params.cfg) === "safeguard") {
  setCompactionSafeguardRuntime(params.sessionManager, { maxHistoryShare });
  paths.push(resolvePiExtensionPath("compaction-safeguard"));
}
```

### Context Pruning

`pi-extensions/context-pruning.ts` は、キャッシュ TTL ベースのコンテキスト剪定を実装します。

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

## Streaming & Block Replies

### Block Chunking

`EmbeddedBlockChunker` は、ストリーミングテキストを個別の返信ブロックに分割して管理します。

```typescript
const blockChunker = blockChunking ? new EmbeddedBlockChunker(blockChunking) : null;
```

### Thinking/Final Tag Stripping

ストリーミング出力は、`<think>` / `<thinking>` ブロックを除去し、`<final>` コンテンツを抽出するように処理されます。

```typescript
const stripBlockTags = (text: string, state: { thinking: boolean; final: boolean }) => {
  // Strip <think>...</think> content
  // If enforceFinalTag, only return <final>...</final> content
};
```

### Reply Directives

`[[media:url]]`、`[[voice]]`、`[[reply:id]]` のような返信ディレクティブが解析・抽出されます。

```typescript
const { text: cleanedText, mediaUrls, audioAsVoice, replyToId } = consumeReplyDirectives(chunk);
```

## Error Handling

### Error Classification

`pi-embedded-helpers.ts` は、適切な処理のためにエラーを分類します。

```typescript
isContextOverflowError(errorText)     // Context too large
isCompactionFailureError(errorText)   // Compaction failed
isAuthAssistantError(lastAssistant)   // Auth failure
isRateLimitAssistantError(...)        // Rate limited
isFailoverAssistantError(...)         // Should failover
classifyFailoverReason(errorText)     // "auth" | "rate_limit" | "quota" | "timeout" | ...
```

### Thinking Level Fallback

思考レベルがサポートされていない場合、フォールバックが行われます。

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

## Sandbox Integration

サンドボックスモードが有効な場合、ツールおよびパスは制約されます。

```typescript
const sandbox = await resolveSandboxContext({
  config: params.config,
  sessionKey: sandboxSessionKey,
  workspaceDir: resolvedWorkspace,
});

if (sandboxRoot) {
  // Use sandboxed read/edit/write tools
  // Exec runs in container
  // Browser uses bridge URL
}
```

## Provider-Specific Handling

### Anthropic

- 拒否用マジック文字列のスクラブ
- 連続するロールに対するターン検証
- Claude Code パラメーター互換性

### Google/Gemini

- ターン順序の修正（`applyGoogleTurnOrderingFix`）
- ツールスキーマのサニタイズ（`sanitizeToolsForGoogle`）
- セッション履歴のサニタイズ（`sanitizeSessionHistory`）

### OpenAI

- Codex モデル向けの `apply_patch` ツール
- 思考レベルのダウングレード処理

## TUI Integration

OpenClaw には、pi-tui コンポーネントを直接使用するローカル TUI モードもあります。

```typescript
// src/tui/tui.ts
import { ... } from "@mariozechner/pi-tui";
```

これにより、pi のネイティブモードに近いインタラクティブなターミナル体験が提供されます。

## Key Differences from Pi CLI

| Aspect          | Pi CLI                            | OpenClaw Embedded                                                                              |
| --------------- | --------------------------------- | ---------------------------------------------------------------------------------------------- |
| Invocation      | `pi` コマンド / RPC                   | `createAgentSession()` 経由の SDK                                                                 |
| Tools           | 既定のコーディングツール                      | カスタム OpenClaw ツールスイート                                                                          |
| System prompt   | AGENTS.md + プロンプト | チャンネル／コンテキストごとに動的                                                                              |
| Session storage | `~/.pi/agent/sessions/`           | `~/.openclaw/agents/<agentId>/sessions/`（または `$OPENCLAW_STATE_DIR/agents/<agentId>/sessions/`） |
| Auth            | 単一クレデンシャル                         | ローテーション付きマルチプロファイル                                                                             |
| Extensions      | ディスクからロード                         | プログラム的 + ディスクパス                                                                                |
| Event handling  | TUI レンダリング                        | コールバックベース（onBlockReply など）                                                                     |

## Future Considerations

潜在的な再作業のための領域:

1. **Tool signature alignment**：現在、pi-agent-core と pi-coding-agent のシグネチャ間でアダプトを実施
2. **Session manager wrapping**：`guardSessionManager` は安全性を追加するが、複雑性が増加
3. **Extension loading**：pi の `ResourceLoader` をより直接的に使用できる可能性
4. **Streaming handler complexity**：`subscribeEmbeddedPiSession` が肥大化
5. **Provider quirks**：pi 側で処理できる可能性のあるプロバイダー固有コードパスが多数存在

## Tests

pi 統合およびその拡張をカバーする既存のテストは次のとおりです。

- `src/agents/pi-embedded-block-chunker.test.ts`
- `src/agents/pi-embedded-helpers.buildbootstrapcontextfiles.test.ts`
- `src/agents/pi-embedded-helpers.classifyfailoverreason.test.ts`
- `src/agents/pi-embedded-helpers.downgradeopenai-reasoning.test.ts`
- `src/agents/pi-embedded-helpers.formatassistanterrortext.test.ts`
- `src/agents/pi-embedded-helpers.formatrawassistanterrorforui.test.ts`
- `src/agents/pi-embedded-helpers.image-dimension-error.test.ts`
- `src/agents/pi-embedded-helpers.image-size-error.test.ts`
- `src/agents/pi-embedded-helpers.isautherrormessage.test.ts`
- `src/agents/pi-embedded-helpers.isbillingerrormessage.test.ts`
- `src/agents/pi-embedded-helpers.iscloudcodeassistformaterror.test.ts`
- `src/agents/pi-embedded-helpers.iscompactionfailureerror.test.ts`
- `src/agents/pi-embedded-helpers.iscontextoverflowerror.test.ts`
- `src/agents/pi-embedded-helpers.isfailovererrormessage.test.ts`
- `src/agents/pi-embedded-helpers.islikelycontextoverflowerror.test.ts`
- `src/agents/pi-embedded-helpers.ismessagingtoolduplicate.test.ts`
- `src/agents/pi-embedded-helpers.messaging-duplicate.test.ts`
- `src/agents/pi-embedded-helpers.normalizetextforcomparison.test.ts`
- `src/agents/pi-embedded-helpers.resolvebootstrapmaxchars.test.ts`
- `src/agents/pi-embedded-helpers.sanitize-session-messages-images.keeps-tool-call-tool-result-ids-unchanged.test.ts`
- `src/agents/pi-embedded-helpers.sanitize-session-messages-images.removes-empty-assistant-text-blocks-but-preserves.test.ts`
- `src/agents/pi-embedded-helpers.sanitizegoogleturnordering.test.ts`
- `src/agents/pi-embedded-helpers.sanitizesessionmessagesimages-thought-signature-stripping.test.ts`
- `src/agents/pi-embedded-helpers.sanitizetoolcallid.test.ts`
- `src/agents/pi-embedded-helpers.sanitizeuserfacingtext.test.ts`
- `src/agents/pi-embedded-helpers.stripthoughtsignatures.test.ts`
- `src/agents/pi-embedded-helpers.validate-turns.test.ts`
- `src/agents/pi-embedded-runner-extraparams.live.test.ts`（live）
- `src/agents/pi-embedded-runner-extraparams.test.ts`
- `src/agents/pi-embedded-runner.applygoogleturnorderingfix.test.ts`
- `src/agents/pi-embedded-runner.buildembeddedsandboxinfo.test.ts`
- `src/agents/pi-embedded-runner.createsystempromptoverride.test.ts`
- `src/agents/pi-embedded-runner.get-dm-history-limit-from-session-key.falls-back-provider-default-per-dm-not.test.ts`
- `src/agents/pi-embedded-runner.get-dm-history-limit-from-session-key.returns-undefined-sessionkey-is-undefined.test.ts`
- `src/agents/pi-embedded-runner.google-sanitize-thinking.test.ts`
- `src/agents/pi-embedded-runner.guard.test.ts`
- `src/agents/pi-embedded-runner.limithistoryturns.test.ts`
- `src/agents/pi-embedded-runner.resolvesessionagentids.test.ts`
- `src/agents/pi-embedded-runner.run-embedded-pi-agent.auth-profile-rotation.test.ts`
- `src/agents/pi-embedded-runner.sanitize-session-history.test.ts`
- `src/agents/pi-embedded-runner.splitsdktools.test.ts`
- `src/agents/pi-embedded-runner.test.ts`
- `src/agents/pi-embedded-subscribe.code-span-awareness.test.ts`
- `src/agents/pi-embedded-subscribe.reply-tags.test.ts`
- `src/agents/pi-embedded-subscribe.subscribe-embedded-pi-session.calls-onblockreplyflush-before-tool-execution-start-preserve.test.ts`
- `src/agents/pi-embedded-subscribe.subscribe-embedded-pi-session.does-not-append-text-end-content-is.test.ts`
- `src/agents/pi-embedded-subscribe.subscribe-embedded-pi-session.does-not-call-onblockreplyflush-callback-is-not.test.ts`
- `src/agents/pi-embedded-subscribe.subscribe-embedded-pi-session.does-not-duplicate-text-end-repeats-full.test.ts`
- `src/agents/pi-embedded-subscribe.subscribe-embedded-pi-session.does-not-emit-duplicate-block-replies-text.test.ts`
- `src/agents/pi-embedded-subscribe.subscribe-embedded-pi-session.emits-block-replies-text-end-does-not.test.ts`
- `src/agents/pi-embedded-subscribe.subscribe-embedded-pi-session.emits-reasoning-as-separate-message-enabled.test.ts`
- `src/agents/pi-embedded-subscribe.subscribe-embedded-pi-session.filters-final-suppresses-output-without-start-tag.test.ts`
- `src/agents/pi-embedded-subscribe.subscribe-embedded-pi-session.includes-canvas-action-metadata-tool-summaries.test.ts`
- `src/agents/pi-embedded-subscribe.subscribe-embedded-pi-session.keeps-assistanttexts-final-answer-block-replies-are.test.ts`
- `src/agents/pi-embedded-subscribe.subscribe-embedded-pi-session.keeps-indented-fenced-blocks-intact.test.ts`
- `src/agents/pi-embedded-subscribe.subscribe-embedded-pi-session.reopens-fenced-blocks-splitting-inside-them.test.ts`
- `src/agents/pi-embedded-subscribe.subscribe-embedded-pi-session.splits-long-single-line-fenced-blocks-reopen.test.ts`
- `src/agents/pi-embedded-subscribe.subscribe-embedded-pi-session.streams-soft-chunks-paragraph-preference.test.ts`
- `src/agents/pi-embedded-subscribe.subscribe-embedded-pi-session.subscribeembeddedpisession.test.ts`
- `src/agents/pi-embedded-subscribe.subscribe-embedded-pi-session.suppresses-message-end-block-replies-message-tool.test.ts`
- `src/agents/pi-embedded-subscribe.subscribe-embedded-pi-session.waits-multiple-compaction-retries-before-resolving.test.ts`
- `src/agents/pi-embedded-subscribe.tools.test.ts`
- `src/agents/pi-embedded-utils.test.ts`
- `src/agents/pi-extensions/compaction-safeguard.test.ts`
- `src/agents/pi-extensions/context-pruning.test.ts`
- `src/agents/pi-settings.test.ts`
- `src/agents/pi-tool-definition-adapter.test.ts`
- `src/agents/pi-tools-agent-config.test.ts`
- `src/agents/pi-tools.create-openclaw-coding-tools.adds-claude-style-aliases-schemas-without-dropping-b.test.ts`
- `src/agents/pi-tools.create-openclaw-coding-tools.adds-claude-style-aliases-schemas-without-dropping-d.test.ts`
- `src/agents/pi-tools.create-openclaw-coding-tools.adds-claude-style-aliases-schemas-without-dropping-f.test.ts`
- `src/agents/pi-tools.create-openclaw-coding-tools.adds-claude-style-aliases-schemas-without-dropping.test.ts`
- `src/agents/pi-tools.policy.test.ts`
- `src/agents/pi-tools.safe-bins.test.ts`
- `src/agents/pi-tools.workspace-paths.test.ts`
