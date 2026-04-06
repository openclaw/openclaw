---
read_when:
    - OpenClawプラグインを構築している場合
    - プラグインの設定スキーマを提供する必要がある、またはプラグインのバリデーションエラーをデバッグする必要がある場合
summary: プラグインマニフェスト + JSONスキーマ要件（厳密な設定バリデーション）
title: プラグインマニフェスト
x-i18n:
    generated_at: "2026-04-02T07:49:54Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: 7d270773e2257faebaae4803c1ed64ef4a078a8e2b99a0559049e58f50b34202
    source_path: plugins/manifest.md
    workflow: 15
---

# プラグインマニフェスト (openclaw.plugin.json)

このページは**ネイティブOpenClawプラグインマニフェスト**のみを対象としています。

互換性のあるバンドルレイアウトについては、[プラグインバンドル](/plugins/bundles)を参照してください。

互換性のあるバンドル形式では、それぞれ異なるマニフェストファイルを使用します：

- Codexバンドル: `.codex-plugin/plugin.json`
- Claudeバンドル: `.claude-plugin/plugin.json` またはマニフェストなしのデフォルトClaudeコンポーネントレイアウト
- Cursorバンドル: `.cursor-plugin/plugin.json`

OpenClawはこれらのバンドルレイアウトも自動検出しますが、ここで説明する`openclaw.plugin.json`スキーマに対するバリデーションは行われません。

互換性のあるバンドルについて、OpenClawは現在、レイアウトがOpenClawランタイムの期待に一致する場合に、バンドルメタデータに加えて、宣言されたSkillルート、Claudeコマンドルート、Claudeバンドルの`settings.json`デフォルト、およびサポートされるフックパックを読み取ります。

すべてのネイティブOpenClawプラグインは、**プラグインルート**に`openclaw.plugin.json`ファイルを含める**必要があります**。OpenClawはこのマニフェストを使用して、**プラグインコードを実行せずに**設定をバリデーションします。マニフェストが欠落しているか無効な場合は、プラグインエラーとして扱われ、設定バリデーションがブロックされます。

完全なプラグインシステムガイドを参照してください：[プラグイン](/tools/plugin)。
ネイティブ機能モデルと現在の外部互換性ガイダンスについては：
[機能モデル](/plugins/architecture#public-capability-model)。

## このファイルの役割

`openclaw.plugin.json`は、OpenClawがプラグインコードを読み込む前に参照するメタデータです。

以下の用途に使用します：

- プラグインの識別
- 設定バリデーション
- プラグインランタイムを起動せずに利用可能であるべき認証およびオンボーディングメタデータ
- バンドル互換配線やコントラクトカバレッジに使用される静的な機能所有権スナップショット
- 設定UIヒント

以下の用途には使用しないでください：

- ランタイム動作の登録
- コードエントリーポイントの宣言
- npmインストールメタデータ

これらはプラグインコードと`package.json`に記述します。

## 最小限の例

```json
{
  "id": "voice-call",
  "configSchema": {
    "type": "object",
    "additionalProperties": false,
    "properties": {}
  }
}
```

## 詳細な例

```json
{
  "id": "openrouter",
  "name": "OpenRouter",
  "description": "OpenRouter provider plugin",
  "version": "1.0.0",
  "providers": ["openrouter"],
  "cliBackends": ["openrouter-cli"],
  "providerAuthEnvVars": {
    "openrouter": ["OPENROUTER_API_KEY"]
  },
  "providerAuthChoices": [
    {
      "provider": "openrouter",
      "method": "api-key",
      "choiceId": "openrouter-api-key",
      "choiceLabel": "OpenRouter API key",
      "groupId": "openrouter",
      "groupLabel": "OpenRouter",
      "optionKey": "openrouterApiKey",
      "cliFlag": "--openrouter-api-key",
      "cliOption": "--openrouter-api-key <key>",
      "cliDescription": "OpenRouter API key",
      "onboardingScopes": ["text-inference"]
    }
  ],
  "uiHints": {
    "apiKey": {
      "label": "API key",
      "placeholder": "sk-or-v1-...",
      "sensitive": true
    }
  },
  "configSchema": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "apiKey": {
        "type": "string"
      }
    }
  }
}
```

## トップレベルフィールドリファレンス

| フィールド            | 必須     | 型                               | 意味                                                                                                                         |
| --------------------- | -------- | -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `id`                  | はい     | `string`                         | 正規のプラグインID。`plugins.entries.<id>`で使用されるIDです。                                                                |
| `configSchema`        | はい     | `object`                         | このプラグインの設定用インラインJSONスキーマ。                                                                                |
| `enabledByDefault`    | いいえ   | `true`                           | バンドルプラグインをデフォルトで有効にします。省略するか、`true`以外の値を設定すると、プラグインはデフォルトで無効になります。 |
| `kind`                | いいえ   | `"memory"` \| `"context-engine"` | `plugins.slots.*`で使用される排他的なプラグイン種別を宣言します。                                                             |
| `channels`            | いいえ   | `string[]`                       | このプラグインが所有するチャネルID。ディスカバリーと設定バリデーションに使用されます。                                        |
| `providers`           | いいえ   | `string[]`                       | このプラグインが所有するプロバイダーID。                                                                                      |
| `cliBackends`         | いいえ   | `string[]`                       | このプラグインが所有するCLI推論バックエンドID。明示的な設定参照からのスタートアップ自動アクティベーションに使用されます。      |
| `providerAuthEnvVars` | いいえ   | `Record<string, string[]>`       | プラグインコードを読み込まずにOpenClawが検査できる、低コストなプロバイダー認証環境変数メタデータ。                             |
| `providerAuthChoices` | いいえ   | `object[]`                       | オンボーディングピッカー、優先プロバイダー解決、シンプルなCLIフラグ配線のための低コストな認証選択メタデータ。                  |
| `contracts`           | いいえ   | `object`                         | 音声、メディア理解、画像生成、ウェブ検索、およびツール所有権のための静的バンドル機能スナップショット。                         |
| `skills`              | いいえ   | `string[]`                       | 読み込むSkillディレクトリ（プラグインルートからの相対パス）。                                                                 |
| `name`                | いいえ   | `string`                         | 人間が読めるプラグイン名。                                                                                                   |
| `description`         | いいえ   | `string`                         | プラグイン画面に表示される短い説明。                                                                                          |
| `version`             | いいえ   | `string`                         | 情報としてのプラグインバージョン。                                                                                            |
| `uiHints`             | いいえ   | `Record<string, object>`         | 設定フィールドのUIラベル、プレースホルダー、機密性ヒント。                                                                    |

## providerAuthChoicesリファレンス

各`providerAuthChoices`エントリは、1つのオンボーディングまたは認証選択肢を記述します。
OpenClawはプロバイダーランタイムが読み込まれる前にこれを読み取ります。

| フィールド         | 必須     | 型                                              | 意味                                                                                                     |
| ------------------ | -------- | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `provider`         | はい     | `string`                                        | この選択肢が属するプロバイダーID。                                                                       |
| `method`           | はい     | `string`                                        | ディスパッチ先の認証メソッドID。                                                                         |
| `choiceId`         | はい     | `string`                                        | オンボーディングおよびCLIフローで使用される安定した認証選択肢ID。                                         |
| `choiceLabel`      | いいえ   | `string`                                        | ユーザー向けラベル。省略した場合、OpenClawは`choiceId`にフォールバックします。                            |
| `choiceHint`       | いいえ   | `string`                                        | ピッカー用の短いヘルパーテキスト。                                                                       |
| `groupId`          | いいえ   | `string`                                        | 関連する選択肢をグループ化するためのオプションのグループID。                                              |
| `groupLabel`       | いいえ   | `string`                                        | そのグループのユーザー向けラベル。                                                                       |
| `groupHint`        | いいえ   | `string`                                        | グループ用の短いヘルパーテキスト。                                                                       |
| `optionKey`        | いいえ   | `string`                                        | シンプルな単一フラグ認証フローのための内部オプションキー。                                                |
| `cliFlag`          | いいえ   | `string`                                        | CLIフラグ名（例：`--openrouter-api-key`）。                                                              |
| `cliOption`        | いいえ   | `string`                                        | 完全なCLIオプション形式（例：`--openrouter-api-key <key>`）。                                            |
| `cliDescription`   | いいえ   | `string`                                        | CLIヘルプで使用される説明。                                                                              |
| `onboardingScopes` | いいえ   | `Array<"text-inference" \| "image-generation">` | この選択肢を表示するオンボーディング画面。省略した場合、デフォルトは`["text-inference"]`です。             |

## uiHintsリファレンス

`uiHints`は設定フィールド名から小さなレンダリングヒントへのマップです。

```json
{
  "uiHints": {
    "apiKey": {
      "label": "API key",
      "help": "Used for OpenRouter requests",
      "placeholder": "sk-or-v1-...",
      "sensitive": true
    }
  }
}
```

各フィールドヒントには以下を含めることができます：

| フィールド    | 型         | 意味                                    |
| ------------- | ---------- | --------------------------------------- |
| `label`       | `string`   | ユーザー向けフィールドラベル。          |
| `help`        | `string`   | 短いヘルパーテキスト。                  |
| `tags`        | `string[]` | オプションのUIタグ。                    |
| `advanced`    | `boolean`  | フィールドを上級者向けとしてマークする。|
| `sensitive`   | `boolean`  | フィールドを機密としてマークする。      |
| `placeholder` | `string`   | フォーム入力のプレースホルダーテキスト。|

## contractsリファレンス

`contracts`は、プラグインランタイムをインポートせずにOpenClawが読み取れる静的な機能所有権メタデータにのみ使用してください。

```json
{
  "contracts": {
    "speechProviders": ["openai"],
    "mediaUnderstandingProviders": ["openai", "openai-codex"],
    "imageGenerationProviders": ["openai"],
    "webSearchProviders": ["gemini"],
    "tools": ["firecrawl_search", "firecrawl_scrape"]
  }
}
```

各リストはオプションです：

| フィールド                    | 型         | 意味                                                           |
| ----------------------------- | ---------- | -------------------------------------------------------------- |
| `speechProviders`             | `string[]` | このプラグインが所有する音声プロバイダーID。                   |
| `mediaUnderstandingProviders` | `string[]` | このプラグインが所有するメディア理解プロバイダーID。           |
| `imageGenerationProviders`    | `string[]` | このプラグインが所有する画像生成プロバイダーID。               |
| `webSearchProviders`          | `string[]` | このプラグインが所有するウェブ検索プロバイダーID。             |
| `tools`                       | `string[]` | バンドルコントラクトチェック用にこのプラグインが所有するエージェントツール名。 |

レガシーのトップレベル`speechProviders`、`mediaUnderstandingProviders`、および`imageGenerationProviders`は非推奨です。`openclaw doctor --fix`を使用して`contracts`配下に移動してください。通常のマニフェスト読み込みでは、これらは機能所有権として扱われなくなりました。

## マニフェストとpackage.jsonの違い

2つのファイルは異なる役割を果たします：

| ファイル               | 用途                                                                                                               |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `openclaw.plugin.json` | プラグインコードの実行前に存在する必要があるディスカバリー、設定バリデーション、認証選択メタデータ、およびUIヒント   |
| `package.json`         | npmメタデータ、依存関係のインストール、およびエントリーポイントやセットアップまたはカタログメタデータに使用される`openclaw`ブロック |

メタデータの配置場所に迷った場合は、以下のルールを使用してください：

- プラグインコードを読み込む前にOpenClawが知る必要がある場合は、`openclaw.plugin.json`に記述する
- パッケージング、エントリーファイル、またはnpmインストール動作に関するものであれば、`package.json`に記述する

## JSONスキーマの要件

- **すべてのプラグインはJSONスキーマを含める必要があります**（設定を受け付けない場合でも）。
- 空のスキーマでも問題ありません（例：`{ "type": "object", "additionalProperties": false }`）。
- スキーマは設定の読み書き時にバリデーションされ、ランタイム時には行われません。

## バリデーション動作

- 不明な`channels.*`キーは、そのチャネルIDがプラグインマニフェストで宣言されていない限り**エラー**になります。
- `plugins.entries.<id>`、`plugins.allow`、`plugins.deny`、および`plugins.slots.*`は**検出可能な**プラグインIDを参照する必要があります。不明なIDは**エラー**になります。
- プラグインがインストールされているがマニフェストやスキーマが壊れている、または欠落している場合、バリデーションは失敗し、Doctorがプラグインエラーを報告します。
- プラグインの設定が存在するがプラグインが**無効**になっている場合、設定は保持され、Doctorとログに**警告**が表示されます。

完全な`plugins.*`スキーマについては、[設定リファレンス](/gateway/configuration)を参照してください。

## 注意事項

- マニフェストは、ローカルファイルシステムからの読み込みを含む**ネイティブOpenClawプラグインに必須**です。
- ランタイムはプラグインモジュールを別途読み込みます。マニフェストはディスカバリーとバリデーションのみに使用されます。
- マニフェストローダーが読み取るのは、ドキュメント化されたマニフェストフィールドのみです。ここにカスタムのトップレベルキーを追加しないでください。
- `providerAuthEnvVars`は、認証プローブ、環境変数マーカーバリデーション、および環境変数名を検査するためだけにプラグインランタイムを起動すべきでない類似のプロバイダー認証サーフェスのための低コストなメタデータパスです。
- `providerAuthChoices`は、プロバイダーランタイムが読み込まれる前の、認証選択ピッカー、`--auth-choice`解決、優先プロバイダーマッピング、およびシンプルなオンボーディングCLIフラグ登録のための低コストなメタデータパスです。プロバイダーコードを必要とするランタイムウィザードメタデータについては、[プロバイダーランタイムフック](/plugins/architecture#provider-runtime-hooks)を参照してください。
- 排他的なプラグイン種別は`plugins.slots.*`を通じて選択されます。
  - `kind: "memory"`は`plugins.slots.memory`で選択されます。
  - `kind: "context-engine"`は`plugins.slots.contextEngine`で選択されます（デフォルト：組み込みの`legacy`）。
- `channels`、`providers`、`cliBackends`、および`skills`は、プラグインがそれらを必要としない場合は省略できます。
- プラグインがネイティブモジュールに依存する場合は、ビルド手順とパッケージマネージャーの許可リスト要件（例：pnpmの`allow-build-scripts` - `pnpm rebuild <package>`）をドキュメントに記載してください。

## 関連

- [プラグイン構築](/plugins/building-plugins) — プラグインのはじめに
- [プラグインアーキテクチャ](/plugins/architecture) — 内部アーキテクチャ
- [SDK 概要](/plugins/sdk-overview) — プラグインSDKリファレンス
