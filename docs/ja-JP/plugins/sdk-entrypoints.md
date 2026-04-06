---
read_when:
    - definePluginEntryまたはdefineChannelPluginEntryの正確な型シグネチャが必要なとき
    - 登録モード（full vs setup vs CLIメタデータ）を理解したいとき
    - エントリーポイントのオプションを調べたいとき
sidebarTitle: Entry Points
summary: definePluginEntry、defineChannelPluginEntry、defineSetupPluginEntryのリファレンス
title: プラグインエントリーポイント
x-i18n:
    generated_at: "2026-04-02T07:49:32Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: 4da57d15b551bd3e897c583b6670bfe7ece9e3426e3d6b25870fae563d746823
    source_path: plugins/sdk-entrypoints.md
    workflow: 15
---

# プラグインエントリーポイント

すべてのプラグインはデフォルトのエントリオブジェクトをエクスポートします。SDKはそれを作成するための3つのヘルパーを提供しています。

<Tip>
  **ウォークスルーをお探しですか？** ステップバイステップのガイドは[チャネルプラグイン](/plugins/sdk-channel-plugins)または[プロバイダープラグイン](/plugins/sdk-provider-plugins)を参照してください。
</Tip>

## `definePluginEntry`

**インポート:** `openclaw/plugin-sdk/plugin-entry`

プロバイダープラグイン、ツールプラグイン、フックプラグイン、およびメッセージングチャネル**以外**のすべてに使用します。

```typescript
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

export default definePluginEntry({
  id: "my-plugin",
  name: "My Plugin",
  description: "Short summary",
  register(api) {
    api.registerProvider({
      /* ... */
    });
    api.registerTool({
      /* ... */
    });
  },
});
```

| フィールド     | 型                                                               | 必須     | デフォルト           |
| -------------- | ---------------------------------------------------------------- | -------- | -------------------- |
| `id`           | `string`                                                         | はい     | —                    |
| `name`         | `string`                                                         | はい     | —                    |
| `description`  | `string`                                                         | はい     | —                    |
| `kind`         | `string`                                                         | いいえ   | —                    |
| `configSchema` | `OpenClawPluginConfigSchema \| () => OpenClawPluginConfigSchema` | いいえ   | 空のオブジェクトスキーマ |
| `register`     | `(api: OpenClawPluginApi) => void`                               | はい     | —                    |

- `id`は`openclaw.plugin.json`マニフェストと一致する必要があります。
- `kind`は排他的スロット用です：`"memory"`または`"context-engine"`。
- `configSchema`は遅延評価のために関数にすることができます。

## `defineChannelPluginEntry`

**インポート:** `openclaw/plugin-sdk/core`

`definePluginEntry`をチャネル固有の配線でラップします。自動的に`api.registerChannel({ plugin })`を呼び出し、オプションのルートヘルプCLIメタデータシームを公開し、登録モードに基づいて`registerFull`をゲートします。

```typescript
import { defineChannelPluginEntry } from "openclaw/plugin-sdk/core";

export default defineChannelPluginEntry({
  id: "my-channel",
  name: "My Channel",
  description: "Short summary",
  plugin: myChannelPlugin,
  setRuntime: setMyRuntime,
  registerCliMetadata(api) {
    api.registerCli(/* ... */);
  },
  registerFull(api) {
    api.registerGatewayMethod(/* ... */);
  },
});
```

| フィールド            | 型                                                               | 必須     | デフォルト           |
| --------------------- | ---------------------------------------------------------------- | -------- | -------------------- |
| `id`                  | `string`                                                         | はい     | —                    |
| `name`                | `string`                                                         | はい     | —                    |
| `description`         | `string`                                                         | はい     | —                    |
| `plugin`              | `ChannelPlugin`                                                  | はい     | —                    |
| `configSchema`        | `OpenClawPluginConfigSchema \| () => OpenClawPluginConfigSchema` | いいえ   | 空のオブジェクトスキーマ |
| `setRuntime`          | `(runtime: PluginRuntime) => void`                               | いいえ   | —                    |
| `registerCliMetadata` | `(api: OpenClawPluginApi) => void`                               | いいえ   | —                    |
| `registerFull`        | `(api: OpenClawPluginApi) => void`                               | いいえ   | —                    |

- `setRuntime`は登録時に呼び出され、ランタイム参照を保存できます（通常は`createPluginRuntimeStore`経由）。CLIメタデータ取得時にはスキップされます。
- `registerCliMetadata`は`api.registrationMode === "cli-metadata"`と`api.registrationMode === "full"`の両方で実行されます。
  チャネルが所有するCLIディスクリプタの標準的な配置場所として使用してください。これにより、ルートヘルプが非アクティブ化のまま維持され、通常のCLIコマンド登録が完全なプラグインロードと互換性を持ちます。
- `registerFull`は`api.registrationMode === "full"`のときのみ実行されます。セットアップのみのロード時にはスキップされます。
- プラグインが所有するルートCLIコマンドについては、コマンドをルートCLIパースツリーから消さずに遅延ロードしたい場合は`api.registerCli(..., { descriptors: [...] })`を推奨します。チャネルプラグインの場合は、`registerCliMetadata(...)`からディスクリプタを登録し、`registerFull(...)`はランタイム専用の処理に集中させることを推奨します。

## `defineSetupPluginEntry`

**インポート:** `openclaw/plugin-sdk/core`

軽量な`setup-entry.ts`ファイル用です。ランタイムやCLI配線なしで`{ plugin }`のみを返します。

```typescript
import { defineSetupPluginEntry } from "openclaw/plugin-sdk/core";

export default defineSetupPluginEntry(myChannelPlugin);
```

OpenClawは、チャネルが無効化されている場合、未設定の場合、または遅延ロードが有効な場合に、完全なエントリの代わりにこれをロードします。これが重要になるタイミングについては[セットアップと設定](/plugins/sdk-setup#setup-entry)を参照してください。

## 登録モード

`api.registrationMode`は、プラグインがどのようにロードされたかを示します：

| モード            | タイミング                         | 登録すべきもの                |
| ----------------- | ---------------------------------- | ----------------------------- |
| `"full"`          | 通常のGateway ゲートウェイ起動時   | すべて                        |
| `"setup-only"`    | 無効/未設定のチャネル              | チャネル登録のみ              |
| `"setup-runtime"` | ランタイムが利用可能なセットアップフロー | チャネル + 軽量ランタイム     |
| `"cli-metadata"`  | ルートヘルプ / CLIメタデータ取得   | CLIディスクリプタのみ         |

`defineChannelPluginEntry`はこの分割を自動的に処理します。チャネルに対して`definePluginEntry`を直接使用する場合は、モードを自分で確認してください：

```typescript
register(api) {
  if (api.registrationMode === "cli-metadata" || api.registrationMode === "full") {
    api.registerCli(/* ... */);
    if (api.registrationMode === "cli-metadata") return;
  }

  api.registerChannel({ plugin: myPlugin });
  if (api.registrationMode !== "full") return;

  // 重いランタイム専用の登録
  api.registerService(/* ... */);
}
```

CLIレジストラについて具体的には：

- レジストラが1つ以上のルートコマンドを所有し、最初の呼び出し時にOpenClawが実際のCLIモジュールを遅延ロードするようにしたい場合は`descriptors`を使用してください
- これらのディスクリプタがレジストラが公開するすべてのトップレベルコマンドルートをカバーしていることを確認してください
- 即時互換パスのみの場合は`commands`のみを使用してください

## プラグインの形状

OpenClawはロードされたプラグインを登録動作によって分類します：

| 形状                  | 説明                                               |
| --------------------- | -------------------------------------------------- |
| **plain-capability**  | 単一の機能タイプ（例：プロバイダーのみ）           |
| **hybrid-capability** | 複数の機能タイプ（例：プロバイダー + 音声）        |
| **hook-only**         | フックのみ、機能なし                               |
| **non-capability**    | ツール/コマンド/サービスのみ、機能なし             |

プラグインの形状を確認するには`openclaw plugins inspect <id>`を使用してください。

## 関連

- [SDK 概要](/plugins/sdk-overview) — 登録APIとサブパスリファレンス
- [ランタイムヘルパー](/plugins/sdk-runtime) — `api.runtime`と`createPluginRuntimeStore`
- [セットアップと設定](/plugins/sdk-setup) — マニフェスト、セットアップエントリ、遅延ロード
- [チャネルプラグイン](/plugins/sdk-channel-plugins) — `ChannelPlugin`オブジェクトの構築
- [プロバイダープラグイン](/plugins/sdk-provider-plugins) — プロバイダー登録とフック
