---
read_when:
    - OPENCLAW_PLUGIN_SDK_COMPAT_DEPRECATED 警告が表示される場合
    - OPENCLAW_EXTENSION_API_DEPRECATED 警告が表示される場合
    - プラグインをモダンなプラグインアーキテクチャに更新する場合
    - 外部 OpenClaw プラグインをメンテナンスしている場合
sidebarTitle: Migrate to SDK
summary: レガシー後方互換性レイヤーからモダンなプラグインSDKへの移行
title: プラグインSDK 移行
x-i18n:
    generated_at: "2026-04-02T07:50:04Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: 0c4766d574771b4675f89d751bfea824ed154c7cb750fd350e3c5a53f16b526d
    source_path: plugins/sdk-migration.md
    workflow: 15
---

# プラグインSDK 移行

OpenClaw は、広範な後方互換性レイヤーから、焦点を絞ったドキュメント付きインポートを持つモダンなプラグインアーキテクチャに移行しました。新しいアーキテクチャ以前に構築されたプラグインをお持ちの場合、このガイドが移行の手助けになります。

## 変更内容

旧プラグインシステムは、プラグインが単一のエントリーポイントから必要なものを何でもインポートできる2つの広範なサーフェスを提供していました：

- **`openclaw/plugin-sdk/compat`** — 数十のヘルパーを再エクスポートする単一のインポート。新しいプラグインアーキテクチャの構築中に、古いフックベースのプラグインを動作させ続けるために導入されました。
- **`openclaw/extension-api`** — プラグインに埋め込みエージェントランナーなどのホスト側ヘルパーへの直接アクセスを提供するブリッジ。

両方のサーフェスは現在 **非推奨** です。ランタイムではまだ動作しますが、新しいプラグインはこれらを使用してはならず、既存のプラグインは次のメジャーリリースで削除される前に移行する必要があります。

<Warning>
  後方互換性レイヤーは将来のメジャーリリースで削除されます。これらのサーフェスからインポートし続けるプラグインは、削除時に動作しなくなります。
</Warning>

## 変更の理由

旧アプローチには問題がありました：

- **起動が遅い** — 1つのヘルパーをインポートすると、関連しない数十のモジュールが読み込まれる
- **循環依存** — 広範な再エクスポートによりインポートサイクルが容易に発生する
- **不明確なAPIサーフェス** — どのエクスポートが安定版で、どれが内部用かを判別する方法がない

モダンなプラグインSDKはこれを解決します。各インポートパス（`openclaw/plugin-sdk/\<subpath\>`）は、明確な目的とドキュメント化されたコントラクトを持つ小さな自己完結型モジュールです。

## 移行方法

<Steps>
  <Step title="非推奨のインポートを検索">
    プラグイン内で、いずれかの非推奨サーフェスからのインポートを検索します：

    ```bash
    grep -r "plugin-sdk/compat" my-plugin/
    grep -r "openclaw/extension-api" my-plugin/
    ```

  </Step>

  <Step title="焦点を絞ったインポートに置き換え">
    旧サーフェスの各エクスポートは、特定のモダンなインポートパスにマッピングされます：

    ```typescript
    // 変更前（非推奨の後方互換性レイヤー）
    import {
      createChannelReplyPipeline,
      createPluginRuntimeStore,
      resolveControlCommandGate,
    } from "openclaw/plugin-sdk/compat";

    // 変更後（モダンな焦点を絞ったインポート）
    import { createChannelReplyPipeline } from "openclaw/plugin-sdk/channel-reply-pipeline";
    import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";
    import { resolveControlCommandGate } from "openclaw/plugin-sdk/command-auth";
    ```

    ホスト側ヘルパーについては、直接インポートする代わりに、注入されたプラグインランタイムを使用します：

    ```typescript
    // 変更前（非推奨の extension-api ブリッジ）
    import { runEmbeddedPiAgent } from "openclaw/extension-api";
    const result = await runEmbeddedPiAgent({ sessionId, prompt });

    // 変更後（注入されたランタイム）
    const result = await api.runtime.agent.runEmbeddedPiAgent({ sessionId, prompt });
    ```

    同じパターンが他のレガシーブリッジヘルパーにも適用されます：

    | 旧インポート | モダンな対応 |
    | --- | --- |
    | `resolveAgentDir` | `api.runtime.agent.resolveAgentDir` |
    | `resolveAgentWorkspaceDir` | `api.runtime.agent.resolveAgentWorkspaceDir` |
    | `resolveAgentIdentity` | `api.runtime.agent.resolveAgentIdentity` |
    | `resolveThinkingDefault` | `api.runtime.agent.resolveThinkingDefault` |
    | `resolveAgentTimeoutMs` | `api.runtime.agent.resolveAgentTimeoutMs` |
    | `ensureAgentWorkspace` | `api.runtime.agent.ensureAgentWorkspace` |
    | セッションストアヘルパー | `api.runtime.agent.session.*` |

  </Step>

  <Step title="ビルドとテスト">
    ```bash
    pnpm build
    pnpm test -- my-plugin/
    ```
  </Step>
</Steps>

## インポートパスリファレンス

<Accordion title="完全なインポートパス一覧">
  | インポートパス | 用途 | 主要なエクスポート |
  | --- | --- | --- |
  | `plugin-sdk/plugin-entry` | 標準プラグインエントリーヘルパー | `definePluginEntry` |
  | `plugin-sdk/core` | チャネルエントリー定義、チャネルビルダー、基本型 | `defineChannelPluginEntry`, `createChatChannelPlugin` |
  | `plugin-sdk/channel-setup` | セットアップウィザードアダプター | `createOptionalChannelSetupSurface` |
  | `plugin-sdk/channel-pairing` | ダイレクトメッセージペアリングプリミティブ | `createChannelPairingController` |
  | `plugin-sdk/channel-reply-pipeline` | リプライプレフィックス＋タイピング接続 | `createChannelReplyPipeline` |
  | `plugin-sdk/channel-config-helpers` | 設定アダプターファクトリ | `createHybridChannelConfigAdapter` |
  | `plugin-sdk/channel-config-schema` | 設定スキーマビルダー | チャネル設定スキーマ型 |
  | `plugin-sdk/channel-policy` | グループ/ダイレクトメッセージポリシー解決 | `resolveChannelGroupRequireMention` |
  | `plugin-sdk/channel-lifecycle` | アカウントステータス追跡 | `createAccountStatusSink` |
  | `plugin-sdk/channel-runtime` | ランタイム接続ヘルパー | チャネルランタイムユーティリティ |
  | `plugin-sdk/channel-send-result` | 送信結果型 | リプライ結果型 |
  | `plugin-sdk/runtime-store` | 永続プラグインストレージ | `createPluginRuntimeStore` |
  | `plugin-sdk/approval-runtime` | 承認プロンプトヘルパー | 実行/プラグイン承認ペイロード、承認機能/プロファイルヘルパー、ネイティブ承認ルーティング/ランタイムヘルパー |
  | `plugin-sdk/collection-runtime` | バウンドキャッシュヘルパー | `pruneMapToMaxSize` |
  | `plugin-sdk/diagnostic-runtime` | 診断ゲーティングヘルパー | `isDiagnosticFlagEnabled`, `isDiagnosticsEnabled` |
  | `plugin-sdk/error-runtime` | エラーフォーマットヘルパー | `formatUncaughtError`、エラーグラフヘルパー |
  | `plugin-sdk/fetch-runtime` | ラップされた fetch/プロキシヘルパー | `resolveFetch`、プロキシヘルパー |
  | `plugin-sdk/host-runtime` | ホスト正規化ヘルパー | `normalizeHostname`, `normalizeScpRemoteHost` |
  | `plugin-sdk/retry-runtime` | リトライヘルパー | `RetryConfig`, `retryAsync`、ポリシーランナー |
  | `plugin-sdk/allow-from` | 許可リストフォーマット | `formatAllowFromLowercase` |
  | `plugin-sdk/allowlist-resolution` | 許可リスト入力マッピング | `mapAllowlistResolutionInputs` |
  | `plugin-sdk/command-auth` | コマンドゲーティング | `resolveControlCommandGate` |
  | `plugin-sdk/secret-input` | シークレット入力解析 | シークレット入力ヘルパー |
  | `plugin-sdk/webhook-ingress` | Webhook リクエストヘルパー | Webhook ターゲットユーティリティ |
  | `plugin-sdk/webhook-request-guards` | Webhook ボディガードヘルパー | リクエストボディ読み取り/制限ヘルパー |
  | `plugin-sdk/reply-payload` | メッセージリプライ型 | リプライペイロード型 |
  | `plugin-sdk/provider-onboard` | プロバイダーオンボーディングパッチ | オンボーディング設定ヘルパー |
  | `plugin-sdk/keyed-async-queue` | 順序付き非同期キュー | `KeyedAsyncQueue` |
  | `plugin-sdk/testing` | テストユーティリティ | テストヘルパーとモック |
</Accordion>

ジョブに合った最も狭いインポートを使用してください。エクスポートが見つからない場合は、`src/plugin-sdk/` のソースを確認するか、Discord でお問い合わせください。

## 削除タイムライン

| 時期                   | 内容                                                            |
| ---------------------- | ----------------------------------------------------------------------- |
| **現在**                | 非推奨サーフェスがランタイム警告を出力する                               |
| **次のメジャーリリース** | 非推奨サーフェスが削除され、まだ使用しているプラグインは動作しなくなる |

すべてのコアプラグインはすでに移行済みです。外部プラグインは次のメジャーリリース前に移行する必要があります。

## 一時的に警告を抑制する

移行作業中に以下の環境変数を設定してください：

```bash
OPENCLAW_SUPPRESS_PLUGIN_SDK_COMPAT_WARNING=1 openclaw gateway run
OPENCLAW_SUPPRESS_EXTENSION_API_WARNING=1 openclaw gateway run
```

これは一時的な回避策であり、恒久的な解決策ではありません。

## 関連

- [はじめに](/plugins/building-plugins) — 最初のプラグインを構築する
- [SDK 概要](/plugins/sdk-overview) — 完全なサブパスインポートリファレンス
- [チャネルプラグイン](/plugins/sdk-channel-plugins) — チャネルプラグインの構築
- [プロバイダープラグイン](/plugins/sdk-provider-plugins) — プロバイダープラグインの構築
- [プラグイン内部構造](/plugins/architecture) — アーキテクチャの詳細
- [プラグインマニフェスト](/plugins/manifest) — マニフェストスキーマリファレンス
