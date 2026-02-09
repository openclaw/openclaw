---
summary: "OpenClaw プラグイン／拡張機能：検出、設定、および安全性"
read_when:
  - プラグイン／拡張機能の追加または変更時
  - プラグインのインストールやロード規則のドキュメント化時
title: "プラグイン"
---

# プラグイン（拡張機能）

## クイックスタート（プラグインが初めての方）

プラグインは、OpenClaw を追加機能（コマンド、ツール、Gateway RPC）で拡張する **小さなコードモジュール** です。

多くの場合、コアの OpenClaw にはまだ組み込まれていない機能が必要なとき（または任意機能をメインのインストールから分離したいとき）にプラグインを使用します。

高速パス:

1. すでにロードされているものを確認します：

```bash
openclaw plugins list
```

2. 公式プラグインをインストールします（例：Voice Call）：

```bash
openclaw plugins install @openclaw/voice-call
```

3. Gateway を再起動し、`plugins.entries.<id>.config` 配下で設定します。

具体的なプラグイン例として、[Voice Call](/plugins/voice-call) を参照してください。

## 利用可能なプラグイン（公式）

- Microsoft Teams は 2026.1.15 時点でプラグイン専用です。Teams を使用する場合は `@openclaw/msteams` をインストールしてください。
- Memory（Core）— 同梱のメモリ検索プラグイン（`plugins.slots.memory` により既定で有効）
- Memory（LanceDB）— 同梱の長期記憶プラグイン（自動リコール／キャプチャ。`plugins.slots.memory = "memory-lancedb"` を設定）
- [Voice Call](/plugins/voice-call) — `@openclaw/voice-call`
- [Zalo Personal](/plugins/zalouser) — `@openclaw/zalouser`
- [Matrix](/channels/matrix) — `@openclaw/matrix`
- [Nostr](/channels/nostr) — `@openclaw/nostr`
- [Zalo](/channels/zalo) — `@openclaw/zalo`
- [Microsoft Teams](/channels/msteams) — `@openclaw/msteams`
- Google Antigravity OAuth（プロバイダー認証）— `google-antigravity-auth` として同梱（既定で無効）
- Gemini CLI OAuth（プロバイダー認証）— `google-gemini-cli-auth` として同梱（既定で無効）
- Qwen OAuth（プロバイダー認証）— `qwen-portal-auth` として同梱（既定で無効）
- Copilot Proxy（プロバイダー認証）— ローカルの VS Code Copilot Proxy ブリッジ。内蔵の `github-copilot` デバイスログインとは別（同梱、既定で無効）

OpenClaw のプラグインは、jiti により実行時にロードされる **TypeScript モジュール** です。**設定検証はプラグインコードを実行しません**。代わりに、プラグインマニフェストと JSON Schema を使用します。[Plugin manifest](/plugins/manifest) を参照してください。 **Config
validationはプラグインコードを実行しません**; プラグインマニフェストと JSON
スキーマを代わりに使用します。 22. [Plugin manifest](/plugins/manifest) を参照してください。

プラグインは次を登録できます：

- Gateway RPC メソッド
- Gateway HTTP ハンドラー
- エージェントツール
- CLI コマンド
- バックグラウンドサービス
- 任意の設定検証
- **Skills**（プラグインマニフェストに `skills` ディレクトリを列挙）
- **自動返信コマンド**（AI エージェントを呼び出さずに実行）

プラグインは Gateway と同一プロセスで実行されます。信頼できるコードとして扱ってください：
23. ツール作成ガイド: [Plugin agent tools](/plugins/agent-tools)。

## ランタイムヘルパー

プラグインは、`api.runtime` を介して選択されたコアヘルパーにアクセスできます。電話向け TTS の場合： テレフォニー TTS:

```ts
const result = await api.runtime.tts.textToSpeechTelephony({
  text: "Hello from OpenClaw",
  cfg: api.config,
});
```

注記：

- コアの `messages.tts` 設定（OpenAI または ElevenLabs）を使用します。
- PCM オーディオバッファとサンプルレートを返します。プロバイダー向けの再サンプリング／エンコードはプラグイン側で行ってください。 プラグインはプロバイダーの再サンプル/エンコードが必要です。
- Edge TTS は電話には対応していません。

## 検出と優先順位

OpenClaw は次の順序でスキャンします：

1. 設定パス

- `plugins.load.paths`（ファイルまたはディレクトリ）

2. ワークスペース拡張

- `<workspace>/.openclaw/extensions/*.ts`
- `<workspace>/.openclaw/extensions/*/index.ts`

3. グローバル拡張

- `~/.openclaw/extensions/*.ts`
- `~/.openclaw/extensions/*/index.ts`

4. 同梱拡張（OpenClaw とともに配布、**既定で無効**）

- `<openclaw>/extensions/*`

バンドルされたプラグインは `plugins.entries.<id> を介して明示的に有効にする必要があります。.enabled` または `openclaw plugins enable <id>` により明示的に有効化する必要があります。インストール済みプラグインは既定で有効ですが、同じ方法で無効化できます。 24. インストールされたプラグインはデフォルトで有効ですが、
同じ方法で無効にすることもできます。

各プラグインは、ルートに `openclaw.plugin.json` ファイルを含める必要があります。パスがファイルを指す場合、プラグインのルートはそのファイルのディレクトリであり、マニフェストを含んでいる必要があります。 パス
がファイルを指す場合、プラグインルートはファイルのディレクトリであり、
マニフェストを含む必要があります。

同じ id に解決されるプラグインが複数ある場合、上記順序で最初に一致したものが優先され、低優先度のコピーは無視されます。

### パッケージパック

プラグインディレクトリには、`openclaw.extensions` を含む `package.json` を含めることができます：

```json
{
  "name": "my-pack",
  "openclaw": {
    "extensions": ["./src/safety.ts", "./src/tools.ts"]
  }
}
```

各エントリはプラグインになります。 各エントリは 1 つのプラグインになります。パックに複数の拡張が含まれる場合、プラグイン id は `name/<fileBase>` になります。

プラグインが npm 依存関係を import する場合は、そのディレクトリにインストールして `node_modules` が利用可能であることを確認してください（`npm install`／`pnpm install`）。

### チャンネルカタログのメタデータ

チャンネルプラグインは、`openclaw.channel` によりオンボーディング用メタデータを、`openclaw.install` によりインストールヒントを告知できます。これにより、コアのカタログをデータフリーに保てます。 これによりコアカタログはデータがなくなります。

例：

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

OpenClaw は **外部チャンネルカタログ**（例：MPM レジストリのエクスポート）もマージできます。次のいずれかに JSON ファイルを配置してください： JSON ファイルを以下のいずれかにドロップします:

- `~/.openclaw/mpm/plugins.json`
- `~/.openclaw/mpm/catalog.json`
- `~/.openclaw/plugins/catalog.json`

または、`OPENCLAW_PLUGIN_CATALOG_PATHS`（または `OPENCLAW_MPM_CATALOG_PATHS`）を、1 つ以上の JSON ファイル（カンマ／セミコロン／`PATH` 区切り）に指定します。各ファイルには `{ "entries": [ { "name": "@scope/pkg", "openclaw": { "channel": {...}, "install": {...} 各ファイルは
`{ "entries": [ { "name": "@scope/pkg", "openclaw": { "channel": {...}, "install": {...} } } ] }\` を含めてください。

## プラグイン ID

既定のプラグイン id：

- パッケージパック：`package.json` `name`
- 単体ファイル：ファイルのベース名（`~/.../voice-call.ts` → `voice-call`）

プラグインが `id` をエクスポートしている場合、OpenClaw はそれを使用しますが、設定された id と一致しない場合は警告します。

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

フィールド：

- `enabled`：マスタートグル（既定：true）
- `allow`：許可リスト（任意）
- `deny`：拒否リスト（任意。拒否が優先）
- `load.paths`：追加のプラグインファイル／ディレクトリ
- `entries.<id>`：プラグインごとのトグル＋設定

設定変更には **Gateway の再起動** が必要です。

検証ルール（厳格）：

- `entries`、`allow`、`deny`、または `slots` に未知のプラグイン id がある場合は **エラー**。
- 未知の `channels.<id>` キーは、プラグインマニフェストがチャンネル id を宣言していない限り **エラー**。
- プラグイン設定は、`openclaw.plugin.json`（`configSchema`）に埋め込まれた JSON Schema を用いて検証されます。
- プラグインが無効の場合でも設定は保持され、**警告** が出力されます。

## プラグインスロット（排他カテゴリ）

一部のプラグインカテゴリは **排他**（同時に 1 つのみ有効）です。どのプラグインがスロットを所有するかは `plugins.slots` で選択します： スロットを所有するプラグインを選択するには、
`plugins.slots` を使用します。

```json5
{
  plugins: {
    slots: {
      memory: "memory-core", // or "none" to disable memory plugins
    },
  },
}
```

複数のプラグインが `kind: "memory"` を宣言している場合、選択されたもののみがロードされ、他は診断付きで無効化されます。 その他の
は診断では無効になっています。

## コントロール UI（スキーマ＋ラベル）

コントロール UI は、`config.schema`（JSON Schema＋`uiHints`）を使用して、より良いフォームを描画します。

OpenClaw は、検出されたプラグインに基づき、実行時に `uiHints` を拡張します：

- `plugins.entries.<id>`／`.enabled`／`.config` のプラグイン別ラベルを追加
- 次の配下に、プラグイン提供の任意の設定フィールドヒントをマージ：
  `plugins.entries.<id>.config.<field>`

プラグインの設定フィールドに適切なラベル／プレースホルダーを表示し、シークレットを機密としてマークしたい場合は、プラグインマニフェストで JSON Schema と並べて `uiHints` を提供してください。

例：

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
openclaw plugins install <path>                 # copy a local file/dir into ~/.openclaw/extensions/<id>
openclaw plugins install ./extensions/voice-call # relative path ok
openclaw plugins install ./plugin.tgz           # install from a local tarball
openclaw plugins install ./plugin.zip           # install from a local zip
openclaw plugins install -l ./extensions/voice-call # link (no copy) for dev
openclaw plugins install @openclaw/voice-call # install from npm
openclaw plugins update <id>
openclaw plugins update --all
openclaw plugins enable <id>
openclaw plugins disable <id>
openclaw plugins doctor
```

`plugins update` は、`plugins.installs` 配下で追跡されている npm インストールにのみ対応します。

プラグインは、独自のトップレベルコマンドを登録することもできます（例：`openclaw voicecall`）。

## プラグイン API（概要）

プラグインは次のいずれかをエクスポートします：

- 関数：`(api) => { ... }`
- オブジェクト：`{ id, name, configSchema, register(api) { ... } }`

## プラグインフック

プラグインはフックを出荷し、実行時に登録することができます。 プラグインはフックを同梱し、実行時に登録できます。これにより、別途フックパックをインストールせずに、イベント駆動の自動化をバンドルできます。

### 例

```
import { registerPluginHooksFromDir } from "openclaw/plugin-sdk";

export default function register(api) {
  registerPluginHooksFromDir(api, "./hooks");
}
```

注記：

- フックディレクトリは通常のフック構造（`HOOK.md`＋`handler.ts`）に従います。
- フックの適格性ルール（OS／バイナリ／環境変数／設定要件）は引き続き適用されます。
- プラグイン管理フックは、`plugin:<id>` 付きで `openclaw hooks list` に表示されます。
- `openclaw hooks` からプラグイン管理フックを有効／無効にすることはできません。代わりにプラグイン自体を有効／無効にしてください。

## プロバイダープラグイン（モデル認証）

プラグインは **モデルプロバイダー認証** フローを登録でき、ユーザーは OpenClaw 内で OAuth や API キー設定を実行できます（外部スクリプト不要）。

`api.registerProvider(...)` からプロバイダを登録します。 `api.registerProvider(...)` によりプロバイダーを登録します。各プロバイダーは 1 つ以上の認証方法（OAuth、API キー、デバイスコードなど）を公開します。これらの方法は次を提供します： これらのメソッドのパワー:

- `openclaw models auth login --provider <id> [--method <id>]`

例：

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
        // Run OAuth flow and return auth profiles.
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

注記：

- `run` は、`prompter`、`runtime`、`openUrl`、`oauth.createVpsAwareHandlers` ヘルパーを備えた `ProviderAuthContext` を受け取ります。
- 既定モデルやプロバイダー設定を追加する必要がある場合は `configPatch` を返してください。
- `--set-default` がエージェントの既定値を更新できるように、`defaultModel` を返してください。

### メッセージングチャンネルの登録

プラグインは、組み込みチャンネル（WhatsApp、Telegram など）のように振る舞う **チャンネルプラグイン** を登録できます。チャンネル設定は `channels.<id> チャンネル設定は `channels.<id>\` 配下に置かれ、チャンネルプラグインのコードで検証されます。

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

注記：

- 設定は `channels.<id>` 配下に置いてください（`plugins.entries` ではありません）。
- `meta.label` は、CLI／UI リストのラベルに使用されます。
- `meta.aliases` は、正規化および CLI 入力のための代替 id を追加します。
- `meta.preferOver` は、両方が設定されている場合に自動有効化をスキップするチャンネル id を列挙します。
- `meta.detailLabel` と `meta.systemImage` により、UI でよりリッチなチャンネルのラベル／アイコンを表示できます。

### 新しいメッセージングチャンネルの作成（ステップバイステップ）

**新しいチャットの受け皿**（「メッセージングチャンネル」）が必要な場合に使用してください。モデルプロバイダーではありません。モデルプロバイダーのドキュメントは `/providers/*` にあります。
モデルプロバイダドキュメントは `/providers/*` の下で動作します。

1. id と設定形状を選択

- すべてのチャンネル設定は `channels.<id>` 配下に置きます。
- マルチアカウント構成には `channels.<id>.accounts.<accountId>` を推奨します。

2. チャンネルメタデータを定義

- `meta.label`、`meta.selectionLabel`、`meta.docsPath`、`meta.blurb` は CLI／UI リストを制御します。
- `meta.docsPath` は、`/channels/<id>` のようなドキュメントページを指す必要があります。
- `meta.preferOver` により、プラグインが別のチャンネルを置き換えられます（自動有効化はそれを優先）。
- `meta.detailLabel` と `meta.systemImage` は、UI の詳細テキスト／アイコンに使用されます。

3. 必須アダプターを実装

- `config.listAccountIds` ＋ `config.resolveAccount`
- `capabilities`（チャット種別、メディア、スレッドなど）
- `outbound.deliveryMode` ＋ `outbound.sendText`（基本的な送信）

4. 必要に応じて任意アダプターを追加

- `setup`（ウィザード）、`security`（DM ポリシー）、`status`（ヘルス／診断）
- `gateway`（開始／停止／ログイン）、`mentions`、`threading`、`streaming`
- `actions`（メッセージアクション）、`commands`（ネイティブコマンドの挙動）

5. プラグインでチャンネルを登録

- `api.registerChannel({ plugin })`

最小設定例：

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

最小のチャンネルプラグイン（送信専用）：

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
      // deliver `text` to your channel here
      return { ok: true };
    },
  },
};

export default function (api) {
  api.registerChannel({ plugin });
}
```

プラグインをロード（extensions ディレクトリまたは `plugins.load.paths`）し、Gateway を再起動してから、設定で `channels.<id>` を構成してください。

### エージェントツール

専用ガイドを参照してください：[Plugin agent tools](/plugins/agent-tools)。

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

プラグインは、**AI エージェントを呼び出さずに** 実行されるカスタムのスラッシュコマンドを登録できます。トグル、ステータス確認、LLM 処理を必要としないクイックアクションに有用です。 これは、LLM処理を必要としないコマンド、ステータスチェック、クイックアクション
の切り替えに便利です。

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

コマンドハンドラーのコンテキスト：

- `senderId`：送信者の ID（利用可能な場合）
- `channel`：コマンドが送信されたチャンネル
- `isAuthorizedSender`：送信者が許可されたユーザーかどうか
- `args`：コマンド後に渡された引数（`acceptsArgs: true` の場合）
- `commandBody`：完全なコマンドテキスト
- `config`：現在の OpenClaw 設定

コマンドオプション：

- `name`：コマンド名（先頭の `/` なし）
- `description`：コマンド一覧に表示されるヘルプテキスト
- `acceptsArgs`：引数を受け付けるか（既定：false）。false の場合、引数が指定されるとマッチせず、メッセージは他のハンドラーにフォールスルーします。 false と引数が指定された場合、コマンドは一致せず、メッセージは他のハンドラに転送されます。
- `requireAuth`：許可された送信者を要求するか（既定：true）
- `handler`：`{ text: string }` を返す関数（async 可）

認可と引数を伴う例：

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

注記：

- プラグインコマンドは、組み込みコマンドおよび AI エージェント **より前** に処理されます。
- コマンドはグローバルに登録され、すべてのチャンネルで機能します。
- コマンド名は大文字小文字を区別しません（`/MyStatus` は `/mystatus` に一致）。
- コマンド名は文字で始まり、文字・数字・ハイフン・アンダースコアのみを含める必要があります。
- 予約済みのコマンド名 (`help`, `status`, `reset`, etc.) プラグインで上書きできません
- プラグイン間で重複するコマンド登録は、診断エラーで失敗します。

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

## 命名規約

- Gateway メソッド：`pluginId.action`（例：`voicecall.status`）
- ツール：`snake_case`（例：`voice_call`）
- CLI コマンド：kebab または camel。ただし、コアコマンドとの衝突は避けてください。

## Skills

プラグインは、リポジトリ内にスキル（`skills/<name>/SKILL.md`）を同梱できます。
`plugins.entries.<id>
同梱プラグインは、`plugins.entries.<id>.enabled\`（または他の設定ゲート）で有効化し、
ワークスペース／管理された Skills の配置場所に存在することを確認してください。

## 配布（npm）

推奨パッケージング：

- メインパッケージ：`openclaw`（このリポジトリ）
- プラグイン：`@openclaw/*` 配下の個別 npm パッケージ（例：`@openclaw/voice-call`）

公開時の契約：

- プラグインの `package.json` には、1 つ以上のエントリーファイルを含む `openclaw.extensions` が必要です。
- エントリーファイルは `.js` または `.ts` にできます（jiti は実行時に TS をロードします）。
- `openclaw plugins install <npm-spec>` は `npm pack` を使用し、`~/.openclaw/extensions/<id>/` に展開して、設定で有効化します。
- 設定キーの安定性：スコープ付きパッケージは、`plugins.entries.*` では **非スコープ** id に正規化されます。

## 例：Voice Call プラグイン

このリポジトリには、音声通話プラグイン（Twilio またはログフォールバック）が含まれています：

- ソース：`extensions/voice-call`
- スキル：`skills/voice-call`
- CLI：`openclaw voicecall start|status`
- ツール：`voice_call`
- RPC：`voicecall.start`、`voicecall.status`
- 設定（twilio）：`provider: "twilio"` ＋ `twilio.accountSid/authToken/from`（任意：`statusCallbackUrl`、`twimlUrl`）
- 設定（dev）：`provider: "log"`（ネットワークなし）

セットアップと使用方法については、[Voice Call](/plugins/voice-call) および `extensions/voice-call/README.md` を参照してください。

## 安全性に関する注意

プラグインはゲートウェイでプロセス内で実行されます。 信頼できるコードとして扱う:

- 信頼できるプラグインのみをインストールしてください。
- `plugins.allow` の許可リストを推奨します。
- 変更後は Gateway を再起動してください。

## プラグインのテスト

プラグインは（可能であれば）テストを同梱してください：

- リポジトリ内プラグインは、`src/**` 配下に Vitest テストを配置できます（例：`src/plugins/voice-call.plugin.test.ts`）。
- 別途公開するプラグインは、独自の CI（lint／build／test）を実行し、`openclaw.extensions` がビルド済みエントリーポイント（`dist/index.js`）を指していることを検証してください。
