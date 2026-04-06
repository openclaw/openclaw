---
title: "Pi インテグレーションアーキテクチャ"
summary: "OpenClaw の組み込み Pi エージェントインテグレーションとセッションライフサイクルのアーキテクチャ"
read_when:
  - OpenClaw の Pi SDK インテグレーション設計を理解する
  - Pi 向けのエージェントセッションライフサイクル、ツール、プロバイダー配線を変更する
x-i18n:
    generated_at: "2026-04-03T00:00:00Z"
    model: claude-sonnet-4-6
    provider: anthropic
    source_hash: 469a4e8760834dc7befafd5af782508c5711b36c3b3f46365d910bdc6742d405
    source_path: pi.md
    workflow: 15
---

# Pi インテグレーションアーキテクチャ

このドキュメントは、OpenClaw が [pi-coding-agent](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent) とその兄弟パッケージ（`pi-ai`、`pi-agent-core`、`pi-tui`）を統合して AI エージェント機能を実現する方法を説明します。

## 概要

OpenClaw は pi SDK を使用して AI コーディングエージェントをメッセージング Gateway ゲートウェイアーキテクチャに組み込みます。pi をサブプロセスとして起動したり RPC モードを使用したりする代わりに、OpenClaw は `createAgentSession()` を通じて pi の `AgentSession` を直接インポートしてインスタンス化します。この組み込みアプローチにより以下が実現します：

- セッションライフサイクルとイベント処理の完全な制御
- カスタムツールの注入（メッセージング、サンドボックス、チャンネル固有のアクション）
- チャンネル/コンテキストごとのシステムプロンプトのカスタマイズ
- 分岐/コンパクションサポートを備えたセッション永続化
- フェイルオーバーを伴うマルチアカウント認証プロファイルローテーション
- プロバイダー非依存のモデル切り替え

## パッケージ依存関係

```json
{
  "@mariozechner/pi-agent-core": "0.61.1",
  "@mariozechner/pi-ai": "0.61.1",
  "@mariozechner/pi-coding-agent": "0.61.1",
  "@mariozechner/pi-tui": "0.61.1"
}
```

| パッケージ        | 目的                                                                                                   |
| ----------------- | ------------------------------------------------------------------------------------------------------ |
| `pi-ai`           | コア LLM 抽象: `Model`、`streamSimple`、メッセージタイプ、プロバイダー API                              |
| `pi-agent-core`   | エージェントループ、ツール実行、`AgentMessage` タイプ                                                   |
| `pi-coding-agent` | 高レベル SDK: `createAgentSession`、`SessionManager`、`AuthStorage`、`ModelRegistry`、組み込みツール    |
| `pi-tui`          | ターミナル UI コンポーネント（OpenClaw のローカル TUI モードで使用）                                     |

## ファイル構造

```
src/agents/
├── pi-embedded-runner.ts          # pi-embedded-runner/ からの再エクスポート
├── pi-embedded-runner/
│   ├── run.ts                     # メインエントリ: runEmbeddedPiAgent()
│   ├── run/
│   │   ├── attempt.ts             # セッション設定を伴う単一試行ロジック
│   │   ├── params.ts              # RunEmbeddedPiAgentParams 型
│   │   ├── payloads.ts            # 実行結果からのレスポンスペイロードのビルド
│   │   ├── images.ts              # ビジョンモデルの画像注入
│   │   └── types.ts               # EmbeddedRunAttemptResult
│   ├── abort.ts                   # 中断エラー検出
│   ├── cache-ttl.ts               # コンテキスト刈り込みのキャッシュ TTL 追跡
│   ├── compact.ts                 # 手動/自動コンパクションロジック
│   ├── extensions.ts              # 組み込み実行用の pi 拡張をロード
│   ├── extra-params.ts            # プロバイダー固有のストリームパラメータ
│   ├── google.ts                  # Google/Gemini ターン順序修正
│   ├── history.ts                 # 履歴制限（DM 対グループ）
│   ├── lanes.ts                   # セッション/グローバルコマンドレーン
│   ├── logger.ts                  # サブシステムロガー
│   ├── model.ts                   # ModelRegistry を通じたモデル解決
│   ├── runs.ts                    # アクティブな実行追跡、中断、キュー
│   ├── sandbox-info.ts            # システムプロンプト用のサンドボックス情報
│   ├── session-manager-cache.ts   # SessionManager インスタンスのキャッシュ
│   ├── session-manager-init.ts    # セッションファイルの初期化
│   ├── system-prompt.ts           # システムプロンプトビルダー
│   ├── tool-split.ts              # ツールを builtIn と custom に分割
│   ├── types.ts                   # EmbeddedPiAgentMeta、EmbeddedPiRunResult
│   └── utils.ts                   # ThinkLevel マッピング、エラー説明
├── pi-embedded-subscribe.ts       # セッションイベントのサブスクリプション/ディスパッチ
├── pi-embedded-subscribe.types.ts # SubscribeEmbeddedPiSessionParams
├── pi-embedded-subscribe.handlers.ts # イベントハンドラーファクトリー
├── pi-embedded-block-chunker.ts   # ストリーミングブロック返信のチャンキング
├── pi-embedded-messaging.ts       # メッセージングツールの送信追跡
├── pi-embedded-helpers.ts         # エラー分類、ターン検証
├── pi-tools.ts                    # createOpenClawCodingTools()
├── pi-tools.abort.ts              # ツール用 AbortSignal ラッピング
├── pi-tools.policy.ts             # ツール許可/拒否リストポリシー
├── pi-tools.read.ts               # 読み取りツールのカスタマイズ
├── pi-tools.schema.ts             # ツールスキーマの正規化
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
├── skills.ts                      # スキルスナップショット/プロンプトビルド
├── sandbox.ts                     # サンドボックスコンテキスト解決
├── channel-tools.ts               # チャンネル固有のツール注入
├── openclaw-tools.ts              # OpenClaw 固有のツール
├── bash-tools.ts                  # exec/プロセスツール
├── apply-patch.ts                 # apply_patch ツール（OpenAI）
├── tools/                         # 個別ツール実装
│   ├── browser-tool.ts
│   ├── canvas-tool.ts
│   ├── cron-tool.ts
│   ├── gateway-tool.ts
│   ├── image-tool.ts
│   ├── message-tool.ts
│   ├── nodes-tool.ts
│   ├── session*.ts
│   ├── web-*.ts
│   └── ...
└── ...
```

チャンネル固有のメッセージアクションランタイムは現在、`src/agents/tools` の下ではなく、プラグイン所有の拡張ディレクトリに配置されています。

## コアインテグレーションフロー

### 1. 組み込みエージェントの実行

メインエントリポイントは `pi-embedded-runner/run.ts` の `runEmbeddedPiAgent()` です：

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

`runEmbeddedAttempt()`（`runEmbeddedPiAgent()` によって呼び出される）内部で pi SDK が使用されます：

```typescript
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
} from "@mariozechner/pi-coding-agent";

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

`subscribeEmbeddedPiSession()` が pi の `AgentSession` イベントをサブスクライブします：

処理されるイベント：

- `message_start` / `message_end` / `message_update`（ストリーミングテキスト/思考）
- `tool_execution_start` / `tool_execution_update` / `tool_execution_end`
- `turn_start` / `turn_end`
- `agent_start` / `agent_end`
- `auto_compaction_start` / `auto_compaction_end`

### 4. プロンプト

セットアップ後、セッションがプロンプトされます：

```typescript
await session.prompt(effectivePrompt, { images: imageResult.images });
```

SDK は完全なエージェントループを処理します：LLM への送信、ツール呼び出しの実行、応答のストリーミング。

## ツールアーキテクチャ

### ツールパイプライン

1. **基本ツール**: pi の `codingTools`（read、bash、edit、write）
2. **カスタム置換**: OpenClaw は bash を `exec`/`process` に置き換え、サンドボックス用に read/edit/write をカスタマイズ
3. **OpenClaw ツール**: メッセージング、ブラウザ、キャンバス、セッション、cron、Gateway ゲートウェイなど
4. **チャンネルツール**: Discord/Telegram/Slack/WhatsApp 固有のアクションツール
5. **ポリシーフィルタリング**: プロファイル、プロバイダー、エージェント、グループ、サンドボックスポリシーによるフィルタリング
6. **スキーマ正規化**: Gemini/OpenAI の癖に対してスキーマをクリーン化
7. **AbortSignal ラッピング**: 中断シグナルを尊重するようにツールをラップ

## システムプロンプト構築

システムプロンプトは `buildAgentSystemPrompt()`（`system-prompt.ts`）で構築されます。ツール、ツール呼び出しスタイル、安全ガードレール、OpenClaw CLI リファレンス、スキル、ドキュメント、ワークスペース、サンドボックス、メッセージング、返信タグ、音声などのセクションを含む完全なプロンプトを組み立てます。

## セッション管理

### セッションファイル

セッションはツリー構造（id/parentId リンク）を持つ JSONL ファイルです。Pi の `SessionManager` が永続化を処理します：

```typescript
const sessionManager = SessionManager.open(params.sessionFile);
```

### 履歴制限

`limitHistoryTurns()` はチャンネルタイプ（DM 対グループ）に基づいて会話履歴をトリムします。

### コンパクション

コンテキストオーバーフロー時に自動コンパクションがトリガーされます。

## 認証とモデル解決

### 認証プロファイル

OpenClaw はプロバイダーごとに複数の API キーを持つ認証プロファイルストアを維持します。プロファイルは失敗時にクールダウン追跡と共にローテーションされます。

### フェイルオーバー

`FailoverError` が設定されている場合にモデルフォールバックをトリガーします。

## Pi 拡張機能

### コンパクションセーフガード

`src/agents/pi-hooks/compaction-safeguard.ts` はコンパクションにガードレールを追加します。

### コンテキスト刈り込み

`src/agents/pi-hooks/context-pruning.ts` はキャッシュ TTL ベースのコンテキスト刈り込みを実装します。

## ストリーミングとブロック返信

### ブロックチャンキング

`EmbeddedBlockChunker` はストリーミングテキストを個別の返信ブロックに管理します。

### 返信ディレクティブ

`[[media:url]]`、`[[voice]]`、`[[reply:id]]` などの返信ディレクティブが解析および抽出されます。

## エラー処理

`pi-embedded-helpers.ts` は適切な処理のためにエラーを分類します。

## サンドボックスインテグレーション

サンドボックスモードが有効な場合、ツールとパスが制約されます。

## プロバイダー固有の処理

### Anthropic

- 拒否マジックストリングのスクラビング
- 連続ロールのターン検証
- Claude Code パラメータの互換性

### Google/Gemini

- ターン順序修正（`applyGoogleTurnOrderingFix`）
- ツールスキーマのサニタイズ（`sanitizeToolsForGoogle`）

### OpenAI

- Codex モデル用の `apply_patch` ツール
- 思考レベルのダウングレード処理

## TUI インテグレーション

OpenClaw にはローカル TUI モードもあり、pi-tui コンポーネントを直接使用します。

## Pi CLI との主な違い

| 側面            | Pi CLI                  | OpenClaw 組み込み                                                                              |
| --------------- | ----------------------- | ---------------------------------------------------------------------------------------------- |
| 呼び出し方      | `pi` コマンド / RPC      | `createAgentSession()` 経由の SDK                                                              |
| ツール          | デフォルトのコーディングツール | カスタム OpenClaw ツールスイート                                                           |
| システムプロンプト | AGENTS.md + プロンプト | チャンネル/コンテキストごとの動的                                                              |
| セッションストレージ | `~/.pi/agent/sessions/` | `~/.openclaw/agents/<agentId>/sessions/`                                                     |
| 認証            | 単一クレデンシャル       | ローテーション付きマルチプロファイル                                                            |

## テスト

Pi インテグレーションのカバレッジはこれらのスイートにまたがっています：

- `src/agents/pi-*.test.ts`
- `src/agents/pi-embedded-*.test.ts`
- `src/agents/pi-tools*.test.ts`

ライブ/オプトイン：

- `src/agents/pi-embedded-runner-extraparams.live.test.ts`（`OPENCLAW_LIVE_TEST=1` で有効化）

現在の実行コマンドについては [Pi Development Workflow](/pi-dev) を参照してください。
