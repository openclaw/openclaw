---
read_when:
    - プラグインにセットアップウィザードを追加する場合
    - setup-entry.ts と index.ts の違いを理解する必要がある場合
    - プラグインの設定スキーマや package.json の openclaw メタデータを定義する場合
sidebarTitle: Setup and Config
summary: セットアップウィザード、setup-entry.ts、設定スキーマ、および package.json メタデータ
title: プラグインセットアップと設定
x-i18n:
    generated_at: "2026-04-02T08:37:01Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: c0e735064153d9d0c854d7017e0158573a3b8e7b33a08fdb39f0022874479f82
    source_path: plugins/sdk-setup.md
    workflow: 15
---

# プラグインセットアップと設定

プラグインのパッケージング（`package.json` メタデータ）、マニフェスト
（`openclaw.plugin.json`）、セットアップエントリー、および設定スキーマのリファレンスです。

<Tip>
  **ウォークスルーをお探しですか？** ハウツーガイドではパッケージングを文脈の中で説明しています：
  [チャネルプラグイン](/plugins/sdk-channel-plugins#step-1-package-and-manifest) および
  [プロバイダープラグイン](/plugins/sdk-provider-plugins#step-1-package-and-manifest)。
</Tip>

## パッケージメタデータ

`package.json` には、プラグインシステムにプラグインが何を提供するかを伝える `openclaw` フィールドが必要です：

**チャネルプラグイン：**

```json
{
  "name": "@myorg/openclaw-my-channel",
  "version": "1.0.0",
  "type": "module",
  "openclaw": {
    "extensions": ["./index.ts"],
    "setupEntry": "./setup-entry.ts",
    "channel": {
      "id": "my-channel",
      "label": "My Channel",
      "blurb": "Short description of the channel."
    }
  }
}
```

**プロバイダープラグイン / ClawHub 公開ベースライン：**

```json openclaw-clawhub-package.json
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

プラグインを ClawHub で外部公開する場合、`compat` と `build` フィールドは必須です。正規の公開スニペットは `docs/snippets/plugin-publish/` にあります。

### `openclaw` フィールド

| フィールド    | 型         | 説明                                                                                       |
| ------------ | ---------- | ------------------------------------------------------------------------------------------ |
| `extensions` | `string[]` | エントリーポイントファイル（パッケージルートからの相対パス）                                               |
| `setupEntry` | `string`   | 軽量なセットアップ専用エントリー（オプション）                                                          |
| `channel`    | `object`   | チャネルメタデータ：`id`、`label`、`blurb`、`selectionLabel`、`docsPath`、`order`、`aliases`         |
| `providers`  | `string[]` | このプラグインが登録するプロバイダー ID                                                              |
| `install`    | `object`   | インストールヒント：`npmSpec`、`localPath`、`defaultChoice`                                       |
| `startup`    | `object`   | 起動時の動作フラグ                                                                              |

### 遅延フルロード

チャネルプラグインは以下の設定で遅延ロードを有効にできます：

```json
{
  "openclaw": {
    "extensions": ["./index.ts"],
    "setupEntry": "./setup-entry.ts",
    "startup": {
      "deferConfiguredChannelFullLoadUntilAfterListen": true
    }
  }
}
```

有効にすると、OpenClaw はリッスン前の起動フェーズ中、すでに設定済みのチャネルであっても `setupEntry` のみをロードします。フルエントリーは Gateway ゲートウェイがリッスンを開始した後にロードされます。

<Warning>
  遅延ロードを有効にするのは、`setupEntry` が Gateway ゲートウェイのリッスン開始前に必要なすべてのもの（チャネル登録、HTTP ルート、Gateway ゲートウェイメソッド）を登録している場合のみにしてください。フルエントリーが起動時に必要な機能を担っている場合は、デフォルトの動作のままにしてください。
</Warning>

## プラグインマニフェスト

すべてのネイティブプラグインは、パッケージルートに `openclaw.plugin.json` を含める必要があります。OpenClaw はプラグインコードを実行せずに設定を検証するためにこれを使用します。

```json
{
  "id": "my-plugin",
  "name": "My Plugin",
  "description": "Adds My Plugin capabilities to OpenClaw",
  "configSchema": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "webhookSecret": {
        "type": "string",
        "description": "Webhook verification secret"
      }
    }
  }
}
```

チャネルプラグインの場合は、`kind` と `channels` を追加します：

```json
{
  "id": "my-channel",
  "kind": "channel",
  "channels": ["my-channel"],
  "configSchema": {
    "type": "object",
    "additionalProperties": false,
    "properties": {}
  }
}
```

設定がないプラグインでもスキーマを含める必要があります。空のスキーマでも有効です：

```json
{
  "id": "my-plugin",
  "configSchema": {
    "type": "object",
    "additionalProperties": false
  }
}
```

完全なスキーマリファレンスについては[プラグインマニフェスト](/plugins/manifest)を参照してください。

## ClawHub への公開

プラグインパッケージの場合は、パッケージ専用の ClawHub コマンドを使用します：

```bash
clawhub package publish your-org/your-plugin --dry-run
clawhub package publish your-org/your-plugin
```

レガシーの Skills 専用公開エイリアスは Skills 用です。プラグインパッケージは常に `clawhub package publish` を使用してください。

## セットアップエントリー

`setup-entry.ts` ファイルは `index.ts` の軽量な代替であり、OpenClaw がセットアップ画面（オンボーディング、設定修復、無効なチャネルの検査）のみを必要とする場合にロードされます。

```typescript
// setup-entry.ts
import { defineSetupPluginEntry } from "openclaw/plugin-sdk/core";
import { myChannelPlugin } from "./src/channel.js";

export default defineSetupPluginEntry(myChannelPlugin);
```

これにより、セットアップフロー中に重いランタイムコード（暗号ライブラリ、CLI 登録、バックグラウンドサービス）のロードを回避できます。

**OpenClaw がフルエントリーの代わりに `setupEntry` を使用する場合：**

- チャネルが無効だがセットアップ／オンボーディング画面が必要な場合
- チャネルが有効だが未設定の場合
- 遅延ロードが有効な場合（`deferConfiguredChannelFullLoadUntilAfterListen`）

**`setupEntry` が登録すべきもの：**

- チャネルプラグインオブジェクト（`defineSetupPluginEntry` 経由）
- Gateway ゲートウェイのリッスン前に必要な HTTP ルート
- 起動時に必要な Gateway ゲートウェイメソッド

**`setupEntry` に含めるべきでないもの：**

- CLI 登録
- バックグラウンドサービス
- 重いランタイムインポート（暗号、SDK）
- 起動後にのみ必要な Gateway ゲートウェイメソッド

## 設定スキーマ

プラグインの設定は、マニフェスト内の JSON Schema に対して検証されます。ユーザーは以下の方法でプラグインを設定します：

```json5
{
  plugins: {
    entries: {
      "my-plugin": {
        config: {
          webhookSecret: "abc123",
        },
      },
    },
  },
}
```

プラグインは登録時に `api.pluginConfig` としてこの設定を受け取ります。

チャネル固有の設定には、代わりにチャネル設定セクションを使用します：

```json5
{
  channels: {
    "my-channel": {
      token: "bot-token",
      allowFrom: ["user1", "user2"],
    },
  },
}
```

### チャネル設定スキーマの構築

`openclaw/plugin-sdk/core` の `buildChannelConfigSchema` を使用して、Zod スキーマを OpenClaw が検証する `ChannelConfigSchema` ラッパーに変換します：

```typescript
import { z } from "zod";
import { buildChannelConfigSchema } from "openclaw/plugin-sdk/core";

const accountSchema = z.object({
  token: z.string().optional(),
  allowFrom: z.array(z.string()).optional(),
  accounts: z.object({}).catchall(z.any()).optional(),
  defaultAccount: z.string().optional(),
});

const configSchema = buildChannelConfigSchema(accountSchema);
```

## セットアップウィザード

チャネルプラグインは `openclaw onboard` 用にインタラクティブなセットアップウィザードを提供できます。ウィザードは `ChannelPlugin` 上の `ChannelSetupWizard` オブジェクトです：

```typescript
import type { ChannelSetupWizard } from "openclaw/plugin-sdk/channel-setup";

const setupWizard: ChannelSetupWizard = {
  channel: "my-channel",
  status: {
    configuredLabel: "Connected",
    unconfiguredLabel: "Not configured",
    resolveConfigured: ({ cfg }) => Boolean((cfg.channels as any)?.["my-channel"]?.token),
  },
  credentials: [
    {
      inputKey: "token",
      providerHint: "my-channel",
      credentialLabel: "Bot token",
      preferredEnvVar: "MY_CHANNEL_BOT_TOKEN",
      envPrompt: "Use MY_CHANNEL_BOT_TOKEN from environment?",
      keepPrompt: "Keep current token?",
      inputPrompt: "Enter your bot token:",
      inspect: ({ cfg, accountId }) => {
        const token = (cfg.channels as any)?.["my-channel"]?.token;
        return {
          accountConfigured: Boolean(token),
          hasConfiguredValue: Boolean(token),
        };
      },
    },
  ],
};
```

`ChannelSetupWizard` 型は `credentials`、`textInputs`、`dmPolicy`、`allowFrom`、`groupAccess`、`prepare`、`finalize` などをサポートしています。完全な例については、バンドルされたプラグインパッケージ（例：Discord プラグインの `src/channel.setup.ts`）を参照してください。

ダイレクトメッセージの許可リストプロンプトで、標準的な `note -> prompt -> parse -> merge -> patch` フローのみが必要な場合は、`openclaw/plugin-sdk/setup` の共有セットアップヘルパー `createPromptParsedAllowFromForAccount(...)`、`createTopLevelChannelParsedAllowFromPrompt(...)`、および `createNestedChannelParsedAllowFromPrompt(...)` を使用してください。

チャネルセットアップのステータスブロックがラベル、スコア、およびオプションの追加行のみで異なる場合は、各プラグインで同じ `status` オブジェクトを手動で作成する代わりに、`openclaw/plugin-sdk/setup` の `createStandardChannelSetupStatus(...)` を使用してください。

特定のコンテキストでのみ表示すべきオプションのセットアップ画面には、`openclaw/plugin-sdk/channel-setup` の `createOptionalChannelSetupSurface` を使用します：

```typescript
import { createOptionalChannelSetupSurface } from "openclaw/plugin-sdk/channel-setup";

const setupSurface = createOptionalChannelSetupSurface({
  channel: "my-channel",
  label: "My Channel",
  npmSpec: "@myorg/openclaw-my-channel",
  docsPath: "/channels/my-channel",
});
// Returns { setupAdapter, setupWizard }
```

## 公開とインストール

**外部プラグイン：** [ClawHub](/tools/clawhub) または npm に公開してからインストールします：

```bash
openclaw plugins install @myorg/openclaw-my-plugin
```

OpenClaw はまず ClawHub を試し、自動的に npm にフォールバックします。特定のソースを強制することもできます：

```bash
openclaw plugins install clawhub:@myorg/openclaw-my-plugin   # ClawHub only
openclaw plugins install npm:@myorg/openclaw-my-plugin       # npm only
```

**リポジトリ内のプラグイン：** バンドルされたプラグインワークスペースツリーの下に配置すると、ビルド時に自動的に検出されます。

**ユーザーはブラウズしてインストールできます：**

```bash
openclaw plugins search <query>
openclaw plugins install <package-name>
```

<Info>
  npm ソースのインストールでは、`openclaw plugins install` は
  `npm install --ignore-scripts`（ライフサイクルスクリプトなし）を実行します。プラグインの依存関係ツリーは純粋な JS/TS に保ち、`postinstall` ビルドを必要とするパッケージは避けてください。
</Info>

## 関連

- [SDK エントリーポイント](/plugins/sdk-entrypoints) -- `definePluginEntry` と `defineChannelPluginEntry`
- [プラグインマニフェスト](/plugins/manifest) -- 完全なマニフェストスキーマリファレンス
- [プラグインの構築](/plugins/building-plugins) -- ステップバイステップのはじめにガイド
