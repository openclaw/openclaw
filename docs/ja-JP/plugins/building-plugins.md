---
read_when:
    - 新しいOpenClawプラグインを作成したい場合
    - プラグイン開発のクイックスタートが必要な場合
    - OpenClawに新しいチャネル、プロバイダー、ツール、またはその他の機能を追加する場合
sidebarTitle: Getting Started
summary: 初めてのOpenClawプラグインを数分で作成する
title: プラグインのビルド
x-i18n:
    generated_at: "2026-04-02T07:49:35Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: fc3e279c504a3fe60c492f06c5689d5a22ecdd82729dd7e834bf7400c73310b4
    source_path: plugins/building-plugins.md
    workflow: 15
---

# プラグインのビルド

プラグインはOpenClawにチャネル、モデルプロバイダー、音声、画像生成、ウェブ検索、エージェントツールなどの新しい機能を追加します。

プラグインをOpenClawリポジトリに追加する必要はありません。[ClawHub](/tools/clawhub)またはnpmに公開すれば、ユーザーは`openclaw plugins install <package-name>`でインストールできます。OpenClawはまずClawHubを確認し、自動的にnpmにフォールバックします。

## 前提条件

- Node >= 22 およびパッケージマネージャー（npmまたはpnpm）
- TypeScript（ESM）の知識
- リポジトリ内プラグインの場合：リポジトリをクローンし`pnpm install`を実行済みであること

## どの種類のプラグイン？

<CardGroup cols={3}>
  <Card title="チャネルプラグイン" icon="messages-square" href="/plugins/sdk-channel-plugins">
    OpenClawをメッセージングプラットフォーム（Discord、IRCなど）に接続する
  </Card>
  <Card title="プロバイダープラグイン" icon="cpu" href="/plugins/sdk-provider-plugins">
    モデルプロバイダー（LLM、プロキシ、またはカスタムエンドポイント）を追加する
  </Card>
  <Card title="ツール / フックプラグイン" icon="wrench">
    エージェントツール、イベントフック、またはサービスを登録する — 以下を参照
  </Card>
</CardGroup>

## クイックスタート: ツールプラグイン

このウォークスルーでは、エージェントツールを登録する最小限のプラグインを作成します。チャネルプラグインとプロバイダープラグインには上記リンクの専用ガイドがあります。

<Steps>
  <Step title="パッケージとマニフェストを作成する">
    <CodeGroup>
    ```json package.json
    {
      "name": "@myorg/openclaw-my-plugin",
      "version": "1.0.0",
      "type": "module",
      "openclaw": {
        "extensions": ["./index.ts"],
        "compat": {
          "pluginApi": ">=2026.3.24-beta.2",
          "minGatewayVersion": "2026.3.24-beta.2"
        },
        "build": {
          "openclawVersion": "2026.3.24-beta.2",
          "pluginSdkVersion": "2026.3.24-beta.2"
        }
      }
    }
    ```

    ```json openclaw.plugin.json
    {
      "id": "my-plugin",
      "name": "My Plugin",
      "description": "Adds a custom tool to OpenClaw",
      "configSchema": {
        "type": "object",
        "additionalProperties": false
      }
    }
    ```
    </CodeGroup>

    すべてのプラグインには設定がなくてもマニフェストが必要です。完全なスキーマについては[マニフェスト](/plugins/manifest)を参照してください。ClawHub公開用の標準スニペットは`docs/snippets/plugin-publish/`にあります。

  </Step>

  <Step title="エントリーポイントを記述する">

    ```typescript
    // index.ts
    import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
    import { Type } from "@sinclair/typebox";

    export default definePluginEntry({
      id: "my-plugin",
      name: "My Plugin",
      description: "Adds a custom tool to OpenClaw",
      register(api) {
        api.registerTool({
          name: "my_tool",
          description: "Do a thing",
          parameters: Type.Object({ input: Type.String() }),
          async execute(_id, params) {
            return { content: [{ type: "text", text: `Got: ${params.input}` }] };
          },
        });
      },
    });
    ```

    `definePluginEntry`はチャネル以外のプラグイン用です。チャネルの場合は`defineChannelPluginEntry`を使用してください — [チャネルプラグイン](/plugins/sdk-channel-plugins)を参照してください。エントリーポイントの全オプションについては[エントリーポイント](/plugins/sdk-entrypoints)を参照してください。

  </Step>

  <Step title="テストと公開">

    **外部プラグイン:** ClawHubで検証・公開し、インストールします：

    ```bash
    clawhub package publish your-org/your-plugin --dry-run
    clawhub package publish your-org/your-plugin
    openclaw plugins install clawhub:@myorg/openclaw-my-plugin
    ```

    OpenClawは`@myorg/openclaw-my-plugin`のようなパッケージ指定に対して、npmより先にClawHubを確認します。

    **リポジトリ内プラグイン:** バンドルプラグインワークスペースツリー内に配置すると自動的に検出されます。

    ```bash
    pnpm test -- <bundled-plugin-root>/my-plugin/
    ```

  </Step>
</Steps>

## プラグインの機能

1つのプラグインで`api`オブジェクトを介して任意の数の機能を登録できます：

| 機能                  | 登録メソッド                                   | 詳細ガイド                                                                      |
| --------------------- | --------------------------------------------- | ------------------------------------------------------------------------------- |
| テキスト推論（LLM）    | `api.registerProvider(...)`                   | [プロバイダープラグイン](/plugins/sdk-provider-plugins)                           |
| CLI推論バックエンド    | `api.registerCliBackend(...)`                 | [CLIバックエンド](/gateway/cli-backends)                                         |
| チャネル / メッセージング | `api.registerChannel(...)`                 | [チャネルプラグイン](/plugins/sdk-channel-plugins)                               |
| 音声（TTS/STT）       | `api.registerSpeechProvider(...)`             | [プロバイダープラグイン](/plugins/sdk-provider-plugins#step-5-add-extra-capabilities) |
| メディア理解          | `api.registerMediaUnderstandingProvider(...)` | [プロバイダープラグイン](/plugins/sdk-provider-plugins#step-5-add-extra-capabilities) |
| 画像生成              | `api.registerImageGenerationProvider(...)`    | [プロバイダープラグイン](/plugins/sdk-provider-plugins#step-5-add-extra-capabilities) |
| ウェブ検索            | `api.registerWebSearchProvider(...)`          | [プロバイダープラグイン](/plugins/sdk-provider-plugins#step-5-add-extra-capabilities) |
| エージェントツール     | `api.registerTool(...)`                       | 以下を参照                                                                       |
| カスタムコマンド       | `api.registerCommand(...)`                    | [エントリーポイント](/plugins/sdk-entrypoints)                                    |
| イベントフック         | `api.registerHook(...)`                       | [エントリーポイント](/plugins/sdk-entrypoints)                                    |
| HTTPルート            | `api.registerHttpRoute(...)`                  | [内部構造](/plugins/architecture#gateway-http-routes)                             |
| CLIサブコマンド        | `api.registerCli(...)`                        | [エントリーポイント](/plugins/sdk-entrypoints)                                    |

完全な登録APIについては[SDK 概要](/plugins/sdk-overview#registration-api)を参照してください。

フックガードのセマンティクスに関する注意事項：

- `before_tool_call`: `{ block: true }`は終端的で、低優先度のハンドラーを停止します。
- `before_tool_call`: `{ block: false }`は判定なしとして扱われます。
- `before_tool_call`: `{ requireApproval: true }`はエージェントの実行を一時停止し、実行承認オーバーレイ、Telegramボタン、Discordインタラクション、または任意のチャネルでの`/approve`コマンドを通じてユーザーに承認を求めます。
- `before_install`: `{ block: true }`は終端的で、低優先度のハンドラーを停止します。
- `before_install`: `{ block: false }`は判定なしとして扱われます。
- `message_sending`: `{ cancel: true }`は終端的で、低優先度のハンドラーを停止します。
- `message_sending`: `{ cancel: false }`は判定なしとして扱われます。

`/approve`コマンドは実行承認とプラグイン承認の両方を自動フォールバックで処理します。プラグイン承認の転送は設定の`approvals.plugin`で個別に構成できます。

詳細は[SDK 概要のフック判定セマンティクス](/plugins/sdk-overview#hook-decision-semantics)を参照してください。

## エージェントツールの登録

ツールはLLMが呼び出せる型付き関数です。必須（常に利用可能）またはオプション（ユーザーがオプトイン）にできます：

```typescript
register(api) {
  // 必須ツール — 常に利用可能
  api.registerTool({
    name: "my_tool",
    description: "Do a thing",
    parameters: Type.Object({ input: Type.String() }),
    async execute(_id, params) {
      return { content: [{ type: "text", text: params.input }] };
    },
  });

  // オプションツール — ユーザーが許可リストに追加する必要がある
  api.registerTool(
    {
      name: "workflow_tool",
      description: "Run a workflow",
      parameters: Type.Object({ pipeline: Type.String() }),
      async execute(_id, params) {
        return { content: [{ type: "text", text: params.pipeline }] };
      },
    },
    { optional: true },
  );
}
```

ユーザーは設定でオプションツールを有効にします：

```json5
{
  tools: { allow: ["workflow_tool"] },
}
```

- ツール名はコアツールと競合してはなりません（競合する場合はスキップされます）
- 副作用や追加バイナリ要件があるツールには`optional: true`を使用してください
- ユーザーはプラグインIDを`tools.allow`に追加することで、プラグインのすべてのツールを有効にできます

## インポート規約

常にフォーカスされた`openclaw/plugin-sdk/<subpath>`パスからインポートしてください：

```typescript
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";

// 間違い: モノリシックルート（非推奨、将来削除予定）
import { ... } from "openclaw/plugin-sdk";
```

完全なサブパスリファレンスについては[SDK 概要](/plugins/sdk-overview)を参照してください。

プラグイン内部では、ローカルバレルファイル（`api.ts`、`runtime-api.ts`）を使用してください — SDKパス経由で自分自身のプラグインをインポートしないでください。

## 提出前チェックリスト

<Check>**package.json**に正しい`openclaw`メタデータがあること</Check>
<Check>**openclaw.plugin.json**マニフェストが存在し、有効であること</Check>
<Check>エントリーポイントが`defineChannelPluginEntry`または`definePluginEntry`を使用していること</Check>
<Check>すべてのインポートがフォーカスされた`plugin-sdk/<subpath>`パスを使用していること</Check>
<Check>内部インポートがローカルモジュールを使用し、SDKセルフインポートでないこと</Check>
<Check>テストが通ること（`pnpm test -- <bundled-plugin-root>/my-plugin/`）</Check>
<Check>`pnpm check`が通ること（リポジトリ内プラグインの場合）</Check>

## ベータリリーステスト

1. [openclaw/openclaw](https://github.com/openclaw/openclaw/releases)のGitHubリリースタグを`Watch` > `Releases`で監視してください。ベータタグは`v2026.3.N-beta.1`のような形式です。リリースのお知らせについては、公式OpenClaw Xアカウント[@openclaw](https://x.com/openclaw)の通知をオンにすることもできます。
2. ベータタグが公開されたらすぐにプラグインをテストしてください。安定版までの期間は通常数時間しかありません。
3. テスト後、Discordの`plugin-forum`チャネルにあるプラグインのスレッドに`all good`または問題点を投稿してください。スレッドがまだない場合は作成してください。
4. 問題が発生した場合は、`Beta blocker: <plugin-name> - <summary>`というタイトルでIssueを作成または更新し、`beta-blocker`ラベルを適用してください。Issueのリンクをスレッドに貼ってください。
5. `fix(<plugin-id>): beta blocker - <summary>`というタイトルで`main`へのPRを作成し、PRとDiscordスレッドの両方にIssueをリンクしてください。コントリビューターはPRにラベルを付けられないため、タイトルがメンテナーと自動化のためのPR側のシグナルとなります。PRがあるブロッカーはマージされます。PRがないブロッカーはそのままリリースされる可能性があります。メンテナーはベータテスト中にこれらのスレッドを監視しています。
6. 沈黙はグリーンを意味します。テスト期間を逃した場合、修正は次のサイクルに持ち越される可能性があります。

## 次のステップ

<CardGroup cols={2}>
  <Card title="チャネルプラグイン" icon="messages-square" href="/plugins/sdk-channel-plugins">
    メッセージングチャネルプラグインをビルドする
  </Card>
  <Card title="プロバイダープラグイン" icon="cpu" href="/plugins/sdk-provider-plugins">
    モデルプロバイダープラグインをビルドする
  </Card>
  <Card title="SDK 概要" icon="book-open" href="/plugins/sdk-overview">
    インポートマップと登録APIリファレンス
  </Card>
  <Card title="ランタイムヘルパー" icon="settings" href="/plugins/sdk-runtime">
    TTS、検索、サブエージェント（api.runtime経由）
  </Card>
  <Card title="テスト" icon="test-tubes" href="/plugins/sdk-testing">
    テストユーティリティとパターン
  </Card>
  <Card title="プラグインマニフェスト" icon="file-json" href="/plugins/manifest">
    完全なマニフェストスキーマリファレンス
  </Card>
</CardGroup>

## 関連

- [プラグインアーキテクチャ](/plugins/architecture) — 内部アーキテクチャの詳細解説
- [SDK 概要](/plugins/sdk-overview) — プラグインSDKリファレンス
- [マニフェスト](/plugins/manifest) — プラグインマニフェスト形式
- [チャネルプラグイン](/plugins/sdk-channel-plugins) — チャネルプラグインのビルド
- [プロバイダープラグイン](/plugins/sdk-provider-plugins) — プロバイダープラグインのビルド
