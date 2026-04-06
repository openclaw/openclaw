---
read_when:
    - どのSDKサブパスからインポートすべきか知りたいとき
    - OpenClawPluginApiのすべての登録メソッドのリファレンスが必要なとき
    - 特定のSDKエクスポートを調べたいとき
sidebarTitle: SDK Overview
summary: インポートマップ、登録APIリファレンス、およびSDKアーキテクチャ
title: プラグインSDK 概要
x-i18n:
    generated_at: "2026-04-02T08:37:32Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: 57266eefa875e49d1b6552adf46afca8f60f5861ba3c871c82c38be541fb7725
    source_path: plugins/sdk-overview.md
    workflow: 15
---

# プラグインSDK 概要

プラグインSDKは、プラグインとコア間の型付きコントラクトです。このページは、**何をインポートするか**と**何を登録できるか**のリファレンスです。

<Tip>
  **ハウツーガイドをお探しですか？**
  - 初めてのプラグインなら、[はじめに](/plugins/building-plugins)をご覧ください
  - チャネルプラグインについては、[チャネルプラグイン](/plugins/sdk-channel-plugins)をご覧ください
  - プロバイダープラグインについては、[プロバイダープラグイン](/plugins/sdk-provider-plugins)をご覧ください
</Tip>

## インポート規約

常に特定のサブパスからインポートしてください：

```typescript
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { defineChannelPluginEntry } from "openclaw/plugin-sdk/core";
```

各サブパスは小さく自己完結したモジュールです。これにより起動が高速になり、循環依存の問題を防ぎます。

## サブパスリファレンス

最もよく使われるサブパスを目的別にグループ化しています。100以上のサブパスの完全なリストは `scripts/lib/plugin-sdk-entrypoints.json` にあります。

### プラグインエントリー

| サブパス                   | 主要なエクスポート                                                                                                                            |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `plugin-sdk/plugin-entry` | `definePluginEntry`                                                                                                                    |
| `plugin-sdk/core`         | `defineChannelPluginEntry`, `createChatChannelPlugin`, `createChannelPluginBase`, `defineSetupPluginEntry`, `buildChannelConfigSchema` |

<AccordionGroup>
  <Accordion title="チャネルサブパス">
    | サブパス | 主要なエクスポート |
    | --- | --- |
    | `plugin-sdk/channel-setup` | `createOptionalChannelSetupSurface` |
    | `plugin-sdk/channel-pairing` | `createChannelPairingController` |
    | `plugin-sdk/channel-reply-pipeline` | `createChannelReplyPipeline` |
    | `plugin-sdk/channel-config-helpers` | `createHybridChannelConfigAdapter` |
    | `plugin-sdk/channel-config-schema` | チャネル設定スキーマの型 |
    | `plugin-sdk/channel-policy` | `resolveChannelGroupRequireMention` |
    | `plugin-sdk/channel-lifecycle` | `createAccountStatusSink` |
    | `plugin-sdk/channel-inbound` | デバウンス、メンションマッチング、エンベロープヘルパー |
    | `plugin-sdk/channel-send-result` | 返信結果の型 |
    | `plugin-sdk/channel-actions` | `createMessageToolButtonsSchema`, `createMessageToolCardSchema` |
    | `plugin-sdk/channel-targets` | ターゲット解析/マッチングヘルパー |
    | `plugin-sdk/channel-contract` | チャネルコントラクトの型 |
    | `plugin-sdk/channel-feedback` | フィードバック/リアクション連携 |
  </Accordion>

  <Accordion title="プロバイダーサブパス">
    | サブパス | 主要なエクスポート |
    | --- | --- |
    | `plugin-sdk/cli-backend` | CLIバックエンドのデフォルト値 + ウォッチドッグ定数 |
    | `plugin-sdk/provider-auth` | `createProviderApiKeyAuthMethod`, `ensureApiKeyFromOptionEnvOrPrompt`, `upsertAuthProfile` |
    | `plugin-sdk/provider-model-shared` | `normalizeModelCompat` |
    | `plugin-sdk/provider-catalog-shared` | `findCatalogTemplate`, `buildSingleProviderApiKeyCatalog` |
    | `plugin-sdk/provider-usage` | `fetchClaudeUsage` など |
    | `plugin-sdk/provider-stream` | ストリームラッパーの型 |
    | `plugin-sdk/provider-onboard` | オンボーディング設定パッチヘルパー |
    | `plugin-sdk/global-singleton` | プロセスローカルなシングルトン/マップ/キャッシュヘルパー |
  </Accordion>

  <Accordion title="認証とセキュリティサブパス">
    | サブパス | 主要なエクスポート |
    | --- | --- |
    | `plugin-sdk/command-auth` | `resolveControlCommandGate` |
    | `plugin-sdk/allow-from` | `formatAllowFromLowercase` |
    | `plugin-sdk/secret-input` | シークレット入力解析ヘルパー |
    | `plugin-sdk/webhook-ingress` | Webhookリクエスト/ターゲットヘルパー |
    | `plugin-sdk/webhook-request-guards` | リクエストボディサイズ/タイムアウトヘルパー |
  </Accordion>

  <Accordion title="ランタイムとストレージサブパス">
    | サブパス | 主要なエクスポート |
    | --- | --- |
    | `plugin-sdk/runtime-store` | `createPluginRuntimeStore` |
    | `plugin-sdk/config-runtime` | 設定の読み込み/書き込みヘルパー |
    | `plugin-sdk/approval-runtime` | 実行/プラグイン承認ヘルパー、承認機能ビルダー、認証/プロファイルヘルパー、ネイティブルーティング/ランタイムヘルパー |
    | `plugin-sdk/infra-runtime` | システムイベント/ハートビートヘルパー |
    | `plugin-sdk/collection-runtime` | 小規模な有界キャッシュヘルパー |
    | `plugin-sdk/diagnostic-runtime` | 診断フラグおよびイベントヘルパー |
    | `plugin-sdk/error-runtime` | エラーグラフおよびフォーマットヘルパー |
    | `plugin-sdk/fetch-runtime` | ラップされたfetch、プロキシ、およびピン留めルックアップヘルパー |
    | `plugin-sdk/host-runtime` | ホスト名およびSCPホスト正規化ヘルパー |
    | `plugin-sdk/retry-runtime` | リトライ設定およびリトライランナーヘルパー |
    | `plugin-sdk/agent-runtime` | エージェントディレクトリ/ID/ワークスペースヘルパー |
    | `plugin-sdk/directory-runtime` | 設定ベースのディレクトリクエリ/重複排除 |
    | `plugin-sdk/keyed-async-queue` | `KeyedAsyncQueue` |
  </Accordion>

  <Accordion title="機能およびテストサブパス">
    | サブパス | 主要なエクスポート |
    | --- | --- |
    | `plugin-sdk/image-generation` | 画像生成プロバイダーの型 |
    | `plugin-sdk/media-understanding` | メディア理解プロバイダーの型 |
    | `plugin-sdk/speech` | 音声プロバイダーの型 |
    | `plugin-sdk/testing` | `installCommonResolveTargetErrorCases`, `shouldAckReaction` |
  </Accordion>
</AccordionGroup>

## 登録API

`register(api)` コールバックは、以下のメソッドを持つ `OpenClawPluginApi` オブジェクトを受け取ります：

### 機能登録

| メソッド                                        | 登録するもの              |
| --------------------------------------------- | ------------------------------ |
| `api.registerProvider(...)`                   | テキスト推論（LLM）           |
| `api.registerCliBackend(...)`                 | ローカルCLI推論バックエンド    |
| `api.registerChannel(...)`                    | メッセージングチャネル              |
| `api.registerSpeechProvider(...)`             | テキスト読み上げ / STT合成 |
| `api.registerMediaUnderstandingProvider(...)` | 画像/音声/動画分析     |
| `api.registerImageGenerationProvider(...)`    | 画像生成               |
| `api.registerWebSearchProvider(...)`          | Web検索                     |

### ツールとコマンド

| メソッド                          | 登録するもの                             |
| ------------------------------- | --------------------------------------------- |
| `api.registerTool(tool, opts?)` | エージェントツール（必須または `{ optional: true }`） |
| `api.registerCommand(def)`      | カスタムコマンド（LLMをバイパス）             |

### インフラストラクチャ

| メソッド                                         | 登録するもの     |
| ---------------------------------------------- | --------------------- |
| `api.registerHook(events, handler, opts?)`     | イベントフック            |
| `api.registerHttpRoute(params)`                | Gateway ゲートウェイ HTTPエンドポイント |
| `api.registerGatewayMethod(name, handler)`     | Gateway ゲートウェイ RPCメソッド    |
| `api.registerCli(registrar, opts?)`            | CLIサブコマンド        |
| `api.registerService(service)`                 | バックグラウンドサービス    |
| `api.registerInteractiveHandler(registration)` | インタラクティブハンドラー   |

### CLI登録メタデータ

`api.registerCli(registrar, opts?)` は2種類のトップレベルメタデータを受け付けます：

- `commands`：レジストラが所有する明示的なコマンドルート
- `descriptors`：ルートCLIのヘルプ、ルーティング、および遅延プラグインCLI登録に使用される解析時のコマンドディスクリプタ

プラグインコマンドを通常のルートCLIパスで遅延読み込みのままにしたい場合は、そのレジストラが公開するすべてのトップレベルコマンドルートをカバーする `descriptors` を提供してください。

```typescript
api.registerCli(
  async ({ program }) => {
    const { registerMatrixCli } = await import("./src/cli.js");
    registerMatrixCli({ program });
  },
  {
    descriptors: [
      {
        name: "matrix",
        description: "Manage Matrix accounts, verification, devices, and profile state",
        hasSubcommands: true,
      },
    ],
  },
);
```

遅延ルートCLI登録が不要な場合は、`commands` を単独で使用してください。この即時互換パスは引き続きサポートされますが、解析時の遅延読み込み用のディスクリプタベースのプレースホルダーはインストールされません。

### CLIバックエンド登録

`api.registerCliBackend(...)` を使用すると、プラグインが `claude-cli` や `codex-cli` などのローカルAI CLIバックエンドのデフォルト設定を所有できます。

- バックエンドの `id` は、`claude-cli/opus` のようなモデル参照のプロバイダープレフィックスになります。
- バックエンドの `config` は `agents.defaults.cliBackends.<id>` と同じ形状を使用します。
- ユーザー設定が常に優先されます。OpenClawはCLIを実行する前に、プラグインのデフォルトの上に `agents.defaults.cliBackends.<id>` をマージします。
- バックエンドがマージ後に互換性の書き換えを必要とする場合（たとえば古いフラグ形状の正規化）は、`normalizeConfig` を使用してください。

### 排他スロット

| メソッド                                     | 登録するもの                     |
| ------------------------------------------ | ------------------------------------- |
| `api.registerContextEngine(id, factory)`   | コンテキストエンジン（一度にひとつのみアクティブ） |
| `api.registerMemoryPromptSection(builder)` | メモリプロンプトセクションビルダー         |
| `api.registerMemoryFlushPlan(resolver)`    | メモリフラッシュプランリゾルバ            |
| `api.registerMemoryRuntime(runtime)`       | メモリランタイムアダプタ                |

### メモリ埋め込みアダプタ

| メソッド                                         | 登録するもの                              |
| ---------------------------------------------- | ---------------------------------------------- |
| `api.registerMemoryEmbeddingProvider(adapter)` | アクティブなプラグイン用のメモリ埋め込みアダプタ |

- `registerMemoryPromptSection`、`registerMemoryFlushPlan`、および `registerMemoryRuntime` はメモリプラグイン専用です。
- `registerMemoryEmbeddingProvider` を使用すると、アクティブなメモリプラグインが1つ以上の埋め込みアダプタID（たとえば `openai`、`gemini`、またはカスタムプラグイン定義のID）を登録できます。
- `agents.defaults.memorySearch.provider` や `agents.defaults.memorySearch.fallback` などのユーザー設定は、これらの登録済みアダプタIDに対して解決されます。

### イベントとライフサイクル

| メソッド                                       | 動作                  |
| -------------------------------------------- | ----------------------------- |
| `api.on(hookName, handler, opts?)`           | 型付きライフサイクルフック          |
| `api.onConversationBindingResolved(handler)` | 会話バインディングコールバック |

### フック判定のセマンティクス

- `before_tool_call`：`{ block: true }` を返すと終端となります。いずれかのハンドラがこれを設定すると、優先度の低いハンドラはスキップされます。
- `before_tool_call`：`{ block: false }` を返すことは判定なし（`block` を省略した場合と同じ）として扱われ、オーバーライドではありません。
- `before_install`：`{ block: true }` を返すと終端となります。いずれかのハンドラがこれを設定すると、優先度の低いハンドラはスキップされます。
- `before_install`：`{ block: false }` を返すことは判定なし（`block` を省略した場合と同じ）として扱われ、オーバーライドではありません。
- `message_sending`：`{ cancel: true }` を返すと終端となります。いずれかのハンドラがこれを設定すると、優先度の低いハンドラはスキップされます。
- `message_sending`：`{ cancel: false }` を返すことは判定なし（`cancel` を省略した場合と同じ）として扱われ、オーバーライドではありません。

### APIオブジェクトのフィールド

| フィールド                    | 型                      | 説明                                                      |
| ------------------------ | ------------------------- | ---------------------------------------------------------------- |
| `api.id`                 | `string`                  | プラグインID                                                        |
| `api.name`               | `string`                  | 表示名                                                     |
| `api.version`            | `string?`                 | プラグインバージョン（任意）                                        |
| `api.description`        | `string?`                 | プラグインの説明（任意）                                    |
| `api.source`             | `string`                  | プラグインソースパス                                               |
| `api.rootDir`            | `string?`                 | プラグインルートディレクトリ（任意）                                 |
| `api.config`             | `OpenClawConfig`          | 現在の設定スナップショット                                          |
| `api.pluginConfig`       | `Record<string, unknown>` | `plugins.entries.<id>.config` からのプラグイン固有の設定        |
| `api.runtime`            | `PluginRuntime`           | [ランタイムヘルパー](/plugins/sdk-runtime)                          |
| `api.logger`             | `PluginLogger`            | スコープ付きロガー（`debug`、`info`、`warn`、`error`）                 |
| `api.registrationMode`   | `PluginRegistrationMode`  | `"full"`、`"setup-only"`、`"setup-runtime"`、または `"cli-metadata"` |
| `api.resolvePath(input)` | `(string) => string`      | プラグインルートからの相対パスを解決                             |

## 内部モジュール規約

プラグイン内部では、内部インポートにローカルバレルファイルを使用してください：

```
my-plugin/
  api.ts            # Public exports for external consumers
  runtime-api.ts    # Internal-only runtime exports
  index.ts          # Plugin entry point
  setup-entry.ts    # Lightweight setup-only entry (optional)
```

<Warning>
  プロダクションコードから `openclaw/plugin-sdk/<your-plugin>` を通じて自身のプラグインをインポートしないでください。内部インポートは `./api.ts` または `./runtime-api.ts` を経由してください。SDKパスは外部コントラクト専用です。
</Warning>

<Warning>
  拡張プロダクションコードも `openclaw/plugin-sdk/<other-plugin>` インポートを避けるべきです。ヘルパーが本当に共有すべきものであれば、2つのプラグインを結合するのではなく、`openclaw/plugin-sdk/speech`、`.../provider-model-shared`、または他の機能指向のサーフェスなどの中立的なSDKサブパスに昇格させてください。
</Warning>

## 関連ドキュメント

- [エントリーポイント](/plugins/sdk-entrypoints) — `definePluginEntry` および `defineChannelPluginEntry` のオプション
- [ランタイムヘルパー](/plugins/sdk-runtime) — 完全な `api.runtime` 名前空間リファレンス
- [セットアップと設定](/plugins/sdk-setup) — パッケージング、マニフェスト、設定スキーマ
- [テスト](/plugins/sdk-testing) — テストユーティリティとlintルール
- [SDK移行](/plugins/sdk-migration) — 非推奨サーフェスからの移行
- [プラグイン内部構造](/plugins/architecture) — 詳細なアーキテクチャと機能モデル
