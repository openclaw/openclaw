---
summary: "OpenClaw プラグイン・エクステンション: 検出、設定、安全性"
read_when:
  - プラグイン・エクステンションの追加または変更
  - プラグインのインストールまたはロードルールのドキュメント化
title: "プラグイン"
---

# プラグイン（エクステンション）

## クイックスタート（プラグインが初めての方へ）

プラグインとは、追加機能（コマンド、ツール、Gateway RPC）で OpenClaw を拡張する**小さなコードモジュール**です。

多くの場合、コア OpenClaw にまだ組み込まれていない機能が必要な場合（またはオプション機能をメインインストールから除外したい場合）にプラグインを使用します。

ファストパス:

1. すでにロードされているものを確認:

```bash
openclaw plugins list
```

2. 公式プラグインをインストール（例: Voice Call）:

```bash
openclaw plugins install @openclaw/voice-call
```

npm スペックは**レジストリのみ**（パッケージ名 + オプションのバージョン・タグ）です。Git/URL/ファイルスペックは拒否されます。

3. Gateway を再起動し、`plugins.entries.<id>.config` で設定します。

具体的なプラグインの例については [Voice Call](/plugins/voice-call) を参照してください。
サードパーティの一覧をお探しですか？[コミュニティプラグイン](/plugins/community) を参照してください。

## 利用可能なプラグイン（公式）

- Microsoft Teams は 2026.1.15 以降プラグイン専用です。Teams を使用する場合は `@openclaw/msteams` をインストールしてください。
- Memory（コア）— バンドルされたメモリ検索プラグイン（`plugins.slots.memory` でデフォルト有効）
- Memory（LanceDB）— バンドルされた長期メモリプラグイン（自動リコール・キャプチャ; `plugins.slots.memory = "memory-lancedb"` で設定）
- [Voice Call](/plugins/voice-call) — `@openclaw/voice-call`
- [Zalo Personal](/plugins/zalouser) — `@openclaw/zalouser`
- [Matrix](/channels/matrix) — `@openclaw/matrix`
- [Nostr](/channels/nostr) — `@openclaw/nostr`
- [Zalo](/channels/zalo) — `@openclaw/zalo`
- [Microsoft Teams](/channels/msteams) — `@openclaw/msteams`
- Google Antigravity OAuth（プロバイダー認証）— `google-antigravity-auth` としてバンドル（デフォルトで無効）
- Gemini CLI OAuth（プロバイダー認証）— `google-gemini-cli-auth` としてバンドル（デフォルトで無効）
- Qwen OAuth（プロバイダー認証）— `qwen-portal-auth` としてバンドル（デフォルトで無効）
- Copilot Proxy（プロバイダー認証）— ローカル VS Code Copilot Proxy ブリッジ; 組み込みの `github-copilot` デバイスログインとは別（バンドル済み、デフォルトで無効）

OpenClaw プラグインは jiti 経由でランタイムにロードされる **TypeScript モジュール**です。**設定の検証はプラグインコードを実行しません**; 代わりにプラグインマニフェストと JSON Schema を使用します。[プラグインマニフェスト](/plugins/manifest) を参照してください。

プラグインは以下を登録できます:

- Gateway RPC メソッド
- Gateway HTTP ハンドラー
- エージェントツール
- CLI コマンド
- バックグラウンドサービス
- オプションの設定検証
- **スキル**（プラグインマニフェストに `skills` ディレクトリを列挙することで）
- **自動返信コマンド**（AI エージェントを呼び出さずに実行）

プラグインは Gateway と**インプロセス**で実行されるため、信頼できるコードとして扱ってください。
ツール作成ガイド: [プラグインエージェントツール](/plugins/agent-tools)。

## ランタイムヘルパー

プラグインは `api.runtime` を通じて選択されたコアヘルパーにアクセスできます。電話 TTS の場合:

```ts
const result = await api.runtime.tts.textToSpeechTelephony({
  text: "Hello from OpenClaw",
  cfg: api.config,
});
```

注意事項:

- コアの `messages.tts` 設定（OpenAI または ElevenLabs）を使用します。
- PCM オーディオバッファ + サンプルレートを返します。プラグインはプロバイダー向けにリサンプリング・エンコードする必要があります。
- Edge TTS は電話には対応していません。

## 検出と優先順位

OpenClaw は以下の順序でスキャンします:

1. 設定パス

- `plugins.load.paths`（ファイルまたはディレクトリ）

2. ワークスペースエクステンション

- `<workspace>/.openclaw/extensions/*.ts`
- `<workspace>/.openclaw/extensions/*/index.ts`

3. グローバルエクステンション

- `~/.openclaw/extensions/*.ts`
- `~/.openclaw/extensions/*/index.ts`

4. バンドルされたエクステンション（OpenClaw に同梱、**デフォルトで無効**）

- `<openclaw>/extensions/*`

バンドルされたプラグインは `plugins.entries.<id>.enabled` または `openclaw plugins enable <id>` で明示的に有効化する必要があります。インストールされたプラグインはデフォルトで有効ですが、同様の方法で無効化できます。

ハードニングに関する注意:

- `plugins.allow` が空でかつ非バンドルプラグインが検出可能な場合、OpenClaw はプラグイン id とソースとともに起動時の警告をログに記録します。
- 候補パスは検出受け入れ前に安全確認されます。OpenClaw は以下の場合に候補をブロックします:
  - エクステンションエントリがプラグインルートの外に解決される場合（シンリンク・パストラバーサルエスケープを含む）、
  - プラグインルート・ソースパスがワールド書き込み可能な場合、
  - 非バンドルプラグインのパス所有者が疑わしい場合（POSIX オーナーが現在の uid でも root でもない）。
- インストール・ロードパスの由来なしにロードされた非バンドルプラグインは、信頼（`plugins.allow`）またはインストール追跡（`plugins.installs`）を固定できるよう警告を発します。

各プラグインはルートに `openclaw.plugin.json` ファイルを含める必要があります。パスがファイルを指している場合、プラグインルートはそのファイルのディレクトリであり、マニフェストを含む必要があります。

複数のプラグインが同じ id に解決される場合、上記の順序での最初のマッチが優先され、低優先度のコピーは無視されます。

### パッケージパック

プラグインディレクトリは `openclaw.extensions` を持つ `package.json` を含む場合があります:

```json
{
  "name": "my-pack",
  "openclaw": {
    "extensions": ["./src/safety.ts", "./src/tools.ts"]
  }
}
```

各エントリがプラグインになります。パックが複数のエクステンションを列挙する場合、プラグイン id は `name/<fileBase>` になります。

プラグインが npm の依存関係をインポートする場合は、そのディレクトリにインストールして
`node_modules` が利用可能にしてください（`npm install` / `pnpm install`）。

セキュリティガードレール: `openclaw.extensions` の各エントリはシンリンク解決後もプラグインディレクトリ内に留まる必要があります。パッケージディレクトリから外れるエントリは拒否されます。

セキュリティに関する注意: `openclaw plugins install` は `npm install --ignore-scripts` でプラグインの依存関係をインストールします（ライフサイクルスクリプトなし）。プラグインの依存関係ツリーを「純粋な JS/TS」に保ち、`postinstall` ビルドを必要とするパッケージを避けてください。

### チャンネルカタログメタデータ

チャンネルプラグインは `openclaw.channel` でオンボーディングメタデータを、`openclaw.install` でインストールヒントを告知できます。これによりコアのカタログデータがフリーになります。

例:

```json
{
  "name": "@openclaw/nextcloud-talk",
  "openclaw": {
    "extensions": ["./index.ts"],
    "channel": {
      "id": "nextcloud-talk",
      "label": "Nextcloud Talk",
      "selectionLabel": "Nextcloud Talk (self-hosted)",
      "docsPath": "/channels/nextcloud-talk",
      "docsLabel": "nextcloud-talk",
      "blurb": "Self-hosted chat via Nextcloud Talk webhook bots.",
      "order": 65,
      "aliases": ["nc-talk", "nc"]
    },
    "install": {
      "npmSpec": "@openclaw/nextcloud-talk",
      "localPath": "extensions/nextcloud-talk",
      "defaultChoice": "npm"
    }
  }
}
```

OpenClaw は**外部チャンネルカタログ**をマージすることもできます（例: MPM レジストリエクスポート）。以下のいずれかに JSON ファイルを配置してください:

- `~/.openclaw/mpm/plugins.json`
- `~/.openclaw/mpm/catalog.json`
- `~/.openclaw/plugins/catalog.json`

または `OPENCLAW_PLUGIN_CATALOG_PATHS`（または `OPENCLAW_MPM_CATALOG_PATHS`）を 1 つ以上の JSON ファイルに向けてください（カンマ・セミコロン・`PATH` 区切り）。各ファイルには `{ "entries": [ { "name": "@scope/pkg", "openclaw": { "channel": {...}, "install": {...} } } ] }` を含める必要があります。

## プラグイン ID

デフォルトのプラグイン id:

- パッケージパック: `package.json` の `name`
- スタンドアロンファイル: ファイルのベース名（`~/.../voice-call.ts` → `voice-call`）

プラグインが `id` をエクスポートする場合、OpenClaw はそれを使用しますが、設定済みの id と一致しない場合は警告を発します。

## 設定

```json5
{
  plugins: {
    enabled: true,
    allow: ["voice-call"],
    deny: ["untrusted-plugin"],
    load: { paths: ["~/Projects/oss/voice-call-extension"] },
    entries: {
      "voice-call": { enabled: true, config: { provider: "twilio" } },
    },
  },
}
```

フィールド:

- `enabled`: マスタートグル（デフォルト: true）
- `allow`: アローリスト（オプション）
- `deny`: デナイリスト（オプション; deny が優先）
- `load.paths`: 追加のプラグインファイル・ディレクトリ
- `entries.<id>`: プラグインごとのトグルと設定

設定変更には **gateway の再起動**が必要です。

検証ルール（厳格）:

- `entries`、`allow`、`deny`、または `slots` の不明なプラグイン id は**エラー**です。
- 不明な `channels.<id>` キーは、プラグインマニフェストがチャンネル id を宣言していない限り**エラー**です。
- プラグイン設定は `openclaw.plugin.json`（`configSchema`）に埋め込まれた JSON Schema を使用して検証されます。
- プラグインが無効の場合、その設定は保持され、**警告**が発せられます。

## プラグインスロット（排他的カテゴリー）

一部のプラグインカテゴリーは**排他的**です（一度に 1 つしかアクティブにできません）。どのプラグインがスロットを所有するかを選択するには `plugins.slots` を使用してください:

```json5
{
  plugins: {
    slots: {
      memory: "memory-core", // またはメモリプラグインを無効化するには "none"
    },
  },
}
```

複数のプラグインが `kind: "memory"` を宣言する場合、選択されたもののみがロードされます。他のものは診断とともに無効化されます。

## コントロール UI（スキーマ + ラベル）

コントロール UI は `config.schema`（JSON Schema + `uiHints`）を使用してより良いフォームをレンダリングします。

OpenClaw は検出されたプラグインに基づいて実行時に `uiHints` を拡張します:

- `plugins.entries.<id>` / `.enabled` / `.config` のプラグインごとのラベルを追加します
- オプションのプラグイン提供の設定フィールドヒントを以下にマージします:
  `plugins.entries.<id>.config.<field>`

プラグインの設定フィールドに適切なラベル・プレースホルダーを表示し（かつシークレットを機密としてマーク）たい場合は、プラグインマニフェストで JSON Schema と並べて `uiHints` を提供してください。

例:

```json
{
  "id": "my-plugin",
  "configSchema": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "apiKey": { "type": "string" },
      "region": { "type": "string" }
    }
  },
  "uiHints": {
    "apiKey": { "label": "API Key", "sensitive": true },
    "region": { "label": "Region", "placeholder": "us-east-1" }
  }
}
```

## CLI

```bash
openclaw plugins list
openclaw plugins info <id>
openclaw plugins install <path>                 # ローカルファイル・ディレクトリを ~/.openclaw/extensions/<id> にコピー
openclaw plugins install ./extensions/voice-call # 相対パス可
openclaw plugins install ./plugin.tgz           # ローカルの tarball からインストール
openclaw plugins install ./plugin.zip           # ローカルの zip からインストール
openclaw plugins install -l ./extensions/voice-call # 開発用にリンク（コピーなし）
openclaw plugins install @openclaw/voice-call # npm からインストール
openclaw plugins install @openclaw/voice-call --pin # 解決された正確な name@version を保存
openclaw plugins update <id>
openclaw plugins update --all
openclaw plugins enable <id>
openclaw plugins disable <id>
openclaw plugins doctor
```

`plugins update` は `plugins.installs` 以下で追跡されている npm インストールにのみ機能します。
更新間で保存された整合性メタデータが変更された場合、OpenClaw は警告を発して確認を求めます（プロンプトをバイパスするにはグローバルの `--yes` を使用）。

プラグインは独自のトップレベルコマンドを登録することもあります（例: `openclaw voicecall`）。

## プラグイン API（概要）

プラグインは以下のいずれかをエクスポートします:

- 関数: `(api) => { ... }`
- オブジェクト: `{ id, name, configSchema, register(api) { ... } }`

## プラグインフック

プラグインはランタイムにフックを登録できます。これにより、プラグインは別のフックパックインストールなしにイベント駆動のオートメーションをバンドルできます。

### 例

```ts
export default function register(api) {
  api.registerHook(
    "command:new",
    async () => {
      // フックロジックをここに記述。
    },
    {
      name: "my-plugin.command-new",
      description: "Runs when /new is invoked",
    },
  );
}
```

注意事項:

- `api.registerHook(...)` でフックを明示的に登録します。
- フック適格ルールは引き続き適用されます（OS・バイナリ・env・設定の要件）。
- プラグイン管理のフックは `openclaw hooks list` に `plugin:<id>` として表示されます。
- プラグイン管理のフックは `openclaw hooks` で有効・無効化できません。代わりにプラグインを有効・無効化してください。

## プロバイダープラグイン（モデル認証）

プラグインは**モデルプロバイダー認証**フローを登録できるため、ユーザーは OpenClaw 内で OAuth または API キーのセットアップを実行できます（外部スクリプトは不要）。

`api.registerProvider(...)` でプロバイダーを登録します。各プロバイダーは 1 つ以上の認証メソッド（OAuth、API キー、デバイスコードなど）を公開します。これらのメソッドは以下を制御します:

- `openclaw models auth login --provider <id> [--method <id>]`

例:

```ts
api.registerProvider({
  id: "acme",
  label: "AcmeAI",
  auth: [
    {
      id: "oauth",
      label: "OAuth",
      kind: "oauth",
      run: async (ctx) => {
        // OAuth フローを実行して認証プロファイルを返す。
        return {
          profiles: [
            {
              profileId: "acme:default",
              credential: {
                type: "oauth",
                provider: "acme",
                access: "...",
                refresh: "...",
                expires: Date.now() + 3600 * 1000,
              },
            },
          ],
          defaultModel: "acme/opus-1",
        };
      },
    },
  ],
});
```

注意事項:

- `run` は `prompter`、`runtime`、`openUrl`、`oauth.createVpsAwareHandlers` ヘルパーを持つ `ProviderAuthContext` を受け取ります。
- デフォルトモデルやプロバイダー設定を追加する必要がある場合は `configPatch` を返します。
- `--set-default` がエージェントのデフォルトを更新できるように `defaultModel` を返します。

### メッセージングチャンネルの登録

プラグインは組み込みチャンネル（WhatsApp、Telegram など）と同様に動作する**チャンネルプラグイン**を登録できます。チャンネル設定は `channels.<id>` の下にあり、チャンネルプラグインコードによって検証されます。

```ts
const myChannel = {
  id: "acmechat",
  meta: {
    id: "acmechat",
    label: "AcmeChat",
    selectionLabel: "AcmeChat (API)",
    docsPath: "/channels/acmechat",
    blurb: "demo channel plugin.",
    aliases: ["acme"],
  },
  capabilities: { chatTypes: ["direct"] },
  config: {
    listAccountIds: (cfg) => Object.keys(cfg.channels?.acmechat?.accounts ?? {}),
    resolveAccount: (cfg, accountId) =>
      cfg.channels?.acmechat?.accounts?.[accountId ?? "default"] ?? {
        accountId,
      },
  },
  outbound: {
    deliveryMode: "direct",
    sendText: async () => ({ ok: true }),
  },
};

export default function (api) {
  api.registerChannel({ plugin: myChannel });
}
```

注意事項:

- 設定は `channels.<id>`（`plugins.entries` ではなく）の下に置きます。
- `meta.label` は CLI・UI リストのラベルに使用されます。
- `meta.aliases` は正規化と CLI 入力のための代替 id を追加します。
- `meta.preferOver` は両方が設定されている場合に自動有効化をスキップするチャンネル id を列挙します。
- `meta.detailLabel` と `meta.systemImage` により UI でリッチなチャンネルラベル・アイコンを表示できます。

### チャンネルオンボーディングフック

チャンネルプラグインは `plugin.onboarding` でオプションのオンボーディングフックを定義できます:

- `configure(ctx)` はベースラインのセットアップフローです。
- `configureInteractive(ctx)` は設定済み・未設定の両方の状態のインタラクティブなセットアップを完全に制御できます。
- `configureWhenConfigured(ctx)` はすでに設定済みのチャンネルの動作のみを上書きできます。

ウィザードでのフック優先順位:

1. `configureInteractive`（存在する場合）
2. `configureWhenConfigured`（チャンネルステータスがすでに設定済みの場合のみ）
3. `configure` にフォールバック

コンテキストの詳細:

- `configureInteractive` と `configureWhenConfigured` は以下を受け取ります:
  - `configured`（`true` または `false`）
  - `label`（プロンプトが使用するユーザー向けチャンネル名）
  - プラス共有の config/runtime/prompter/options フィールド
- `"skip"` を返すと選択とアカウント追跡が変更されません。
- `{ cfg, accountId? }` を返すと設定の更新とアカウント選択が記録されます。

### 新しいメッセージングチャンネルの作成（ステップバイステップ）

モデルプロバイダーではなく**新しいチャットサーフェス**（「メッセージングチャンネル」）が必要な場合に使用します。
モデルプロバイダーのドキュメントは `/providers/*` にあります。

1. id と設定の形状を選択する

- すべてのチャンネル設定は `channels.<id>` の下にあります。
- マルチアカウントのセットアップには `channels.<id>.accounts.<accountId>` を優先してください。

2. チャンネルメタデータを定義する

- `meta.label`、`meta.selectionLabel`、`meta.docsPath`、`meta.blurb` は CLI・UI リストを制御します。
- `meta.docsPath` は `/channels/<id>` のようなドキュメントページを指す必要があります。
- `meta.preferOver` はプラグインが別のチャンネルを置き換えることを許可します（自動有効化がそれを優先します）。
- `meta.detailLabel` と `meta.systemImage` は UI が詳細テキスト・アイコンを表示するために使用します。

3. 必要なアダプターを実装する

- `config.listAccountIds` + `config.resolveAccount`
- `capabilities`（チャットタイプ、メディア、スレッドなど）
- `outbound.deliveryMode` + `outbound.sendText`（基本的な送信用）

4. 必要に応じてオプションのアダプターを追加する

- `setup`（ウィザード）、`security`（DM ポリシー）、`status`（ヘルス・診断）
- `gateway`（開始・停止・ログイン）、`mentions`、`threading`、`streaming`
- `actions`（メッセージアクション）、`commands`（ネイティブコマンドの動作）

5. プラグインにチャンネルを登録する

- `api.registerChannel({ plugin })`

最小設定の例:

```json5
{
  channels: {
    acmechat: {
      accounts: {
        default: { token: "ACME_TOKEN", enabled: true },
      },
    },
  },
}
```

最小チャンネルプラグイン（アウトバウンドのみ）:

```ts
const plugin = {
  id: "acmechat",
  meta: {
    id: "acmechat",
    label: "AcmeChat",
    selectionLabel: "AcmeChat (API)",
    docsPath: "/channels/acmechat",
    blurb: "AcmeChat messaging channel.",
    aliases: ["acme"],
  },
  capabilities: { chatTypes: ["direct"] },
  config: {
    listAccountIds: (cfg) => Object.keys(cfg.channels?.acmechat?.accounts ?? {}),
    resolveAccount: (cfg, accountId) =>
      cfg.channels?.acmechat?.accounts?.[accountId ?? "default"] ?? {
        accountId,
      },
  },
  outbound: {
    deliveryMode: "direct",
    sendText: async ({ text }) => {
      // ここでチャンネルに `text` を配信する
      return { ok: true };
    },
  },
};

export default function (api) {
  api.registerChannel({ plugin });
}
```

プラグインをロードし（エクステンションディレクトリまたは `plugins.load.paths`）、gateway を再起動し、
設定で `channels.<id>` を設定します。

### エージェントツール

専用のガイドを参照してください: [プラグインエージェントツール](/plugins/agent-tools)。

### Gateway RPC メソッドの登録

```ts
export default function (api) {
  api.registerGatewayMethod("myplugin.status", ({ respond }) => {
    respond(true, { ok: true });
  });
}
```

### CLI コマンドの登録

```ts
export default function (api) {
  api.registerCli(
    ({ program }) => {
      program.command("mycmd").action(() => {
        console.log("Hello");
      });
    },
    { commands: ["mycmd"] },
  );
}
```

### 自動返信コマンドの登録

プラグインは **AI エージェントを呼び出さずに**実行するカスタムスラッシュコマンドを登録できます。これはトグルコマンド、ステータスチェック、LLM 処理を必要としないクイックアクションに便利です。

```ts
export default function (api) {
  api.registerCommand({
    name: "mystatus",
    description: "Show plugin status",
    handler: (ctx) => ({
      text: `Plugin is running! Channel: ${ctx.channel}`,
    }),
  });
}
```

コマンドハンドラーのコンテキスト:

- `senderId`: 送信者の ID（利用可能な場合）
- `channel`: コマンドが送信されたチャンネル
- `isAuthorizedSender`: 送信者が認証済みユーザーかどうか
- `args`: コマンドの後に渡された引数（`acceptsArgs: true` の場合）
- `commandBody`: コマンドの完全なテキスト
- `config`: 現在の OpenClaw 設定

コマンドオプション:

- `name`: コマンド名（先頭の `/` なし）
- `description`: コマンドリストに表示されるヘルプテキスト
- `acceptsArgs`: コマンドが引数を受け付けるかどうか（デフォルト: false）。false で引数が提供された場合、コマンドはマッチせず、メッセージは他のハンドラーにフォールスルーします
- `requireAuth`: 認証済み送信者が必要かどうか（デフォルト: true）
- `handler`: `{ text: string }` を返す関数（非同期可）

認証と引数を持つ例:

```ts
api.registerCommand({
  name: "setmode",
  description: "Set plugin mode",
  acceptsArgs: true,
  requireAuth: true,
  handler: async (ctx) => {
    const mode = ctx.args?.trim() || "default";
    await saveMode(mode);
    return { text: `Mode set to: ${mode}` };
  },
});
```

注意事項:

- プラグインコマンドは組み込みコマンドと AI エージェントの**前**に処理されます
- コマンドはグローバルに登録され、すべてのチャンネルで機能します
- コマンド名は大文字・小文字を区別しません（`/MyStatus` は `/mystatus` にマッチします）
- コマンド名は文字で始まり、文字・数字・ハイフン・アンダースコアのみを含む必要があります
- 予約済みコマンド名（`help`、`status`、`reset` など）はプラグインで上書きできません
- プラグイン間での重複したコマンド登録は診断エラーで失敗します

### バックグラウンドサービスの登録

```ts
export default function (api) {
  api.registerService({
    id: "my-service",
    start: () => api.logger.info("ready"),
    stop: () => api.logger.info("bye"),
  });
}
```

## 命名規則

- Gateway メソッド: `pluginId.action`（例: `voicecall.status`）
- ツール: `snake_case`（例: `voice_call`）
- CLI コマンド: ケバブまたはキャメル、ただしコアコマンドとの衝突を避けること

## スキル

プラグインはリポジトリ（`skills/<name>/SKILL.md`）にスキルを提供できます。
`plugins.entries.<id>.enabled`（またはその他の設定ゲート）で有効化し、
ワークスペース・管理済みスキルの場所に存在することを確認してください。

## 配布（npm）

推奨パッケージング:

- メインパッケージ: `openclaw`（このリポジトリ）
- プラグイン: `@openclaw/*` の下の独立した npm パッケージ（例: `@openclaw/voice-call`）

公開コントラクト:

- プラグインの `package.json` には 1 つ以上のエントリファイルを持つ `openclaw.extensions` を含める必要があります。
- エントリファイルは `.js` または `.ts`（jiti がランタイムに TS をロード）が使用できます。
- `openclaw plugins install <npm-spec>` は `npm pack` を使用し、`~/.openclaw/extensions/<id>/` に展開して設定で有効化します。
- 設定キーの安定性: スコープ付きパッケージは `plugins.entries.*` の**スコープなし** id に正規化されます。

## プラグインの例: Voice Call

このリポジトリには Voice Call プラグイン（Twilio またはログフォールバック）が含まれています:

- ソース: `extensions/voice-call`
- スキル: `skills/voice-call`
- CLI: `openclaw voicecall start|status`
- ツール: `voice_call`
- RPC: `voicecall.start`, `voicecall.status`
- 設定（twilio）: `provider: "twilio"` + `twilio.accountSid/authToken/from`（オプションの `statusCallbackUrl`、`twimlUrl`）
- 設定（dev）: `provider: "log"`（ネットワークなし）

セットアップと使用方法については [Voice Call](/plugins/voice-call) と `extensions/voice-call/README.md` を参照してください。

## 安全性に関する注意事項

プラグインは Gateway とインプロセスで実行されます。信頼できるコードとして扱ってください:

- 信頼できるプラグインのみをインストールしてください。
- `plugins.allow` アローリストを優先してください。
- 変更後は Gateway を再起動してください。

## プラグインのテスト

プラグインはテストを提供すべきです（すべき）:

- リポジトリ内プラグインは `src/**` の下に Vitest テストを置けます（例: `src/plugins/voice-call.plugin.test.ts`）。
- 個別に公開されたプラグインは独自の CI（lint/build/test）を実行し、`openclaw.extensions` がビルドされたエントリポイント（`dist/index.js`）を指していることを検証すべきです。
