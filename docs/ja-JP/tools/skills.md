---
summary: "スキル: 管理済み対ワークスペース、ゲートルール、設定・env の配線"
read_when:
  - スキルの追加または変更
  - スキルのゲートやロードルールの変更
title: "スキル"
---

# スキル (OpenClaw)

OpenClaw は**[AgentSkills](https://agentskills.io) 互換**のスキルフォルダーを使用して、エージェントにツールの使い方を教えます。各スキルは YAML フロントマターと手順を含む `SKILL.md` を持つディレクトリです。OpenClaw は**バンドルされたスキル**とオプションのローカルオーバーライドをロードし、環境・設定・バイナリの存在に基づいてロード時にフィルタリングします。

## ロケーションと優先順位

スキルは**3 つ**の場所からロードされます:

1. **バンドルされたスキル**: インストール（npm パッケージまたは OpenClaw.app）に同梱
2. **管理済み・ローカルスキル**: `~/.openclaw/skills`
3. **ワークスペーススキル**: `<workspace>/skills`

スキル名が競合する場合、優先順位は:

`<workspace>/skills`（最高）→ `~/.openclaw/skills` → バンドルされたスキル（最低）

さらに、`~/.openclaw/openclaw.json` の `skills.load.extraDirs` で追加のスキルフォルダーを設定できます（最低優先度）。

## エージェントごと対共有スキル

**マルチエージェント**設定では、各エージェントは独自のワークスペースを持ちます。つまり:

- **エージェントごとのスキル**はそのエージェントのみの `<workspace>/skills` に存在します。
- **共有スキル**は `~/.openclaw/skills`（管理済み・ローカル）に存在し、同一マシン上の**すべてのエージェント**から見えます。
- **共有フォルダー**は、複数のエージェントが使用する共通のスキルパックが必要な場合、`skills.load.extraDirs`（最低優先度）で追加することもできます。

同一のスキル名が複数の場所に存在する場合、通常の優先順位が適用されます: ワークスペースが優先、次に管理済み・ローカル、次にバンドル。

## プラグインとスキル

プラグインは `openclaw.plugin.json` に `skills` ディレクトリを列挙することで独自のスキルを提供できます（パスはプラグインルートからの相対パス）。プラグインスキルはプラグインが有効な場合にロードされ、通常のスキル優先順位ルールに従います。
プラグインの設定エントリの `metadata.openclaw.requires.config` を使用してゲートできます。検出・設定については [プラグイン](/tools/plugin) を、それらのスキルが教えるツールサーフェスについては [ツール](/tools) を参照してください。

## ClawHub（インストール + 同期）

ClawHub は OpenClaw の公開スキルレジストリです。[https://clawhub.com](https://clawhub.com) でブラウズできます。スキルの検出、インストール、更新、バックアップに使用してください。
完全なガイド: [ClawHub](/tools/clawhub)。

よくある使い方:

- スキルをワークスペースにインストール:
  - `clawhub install <skill-slug>`
- インストール済みスキルをすべて更新:
  - `clawhub update --all`
- 同期（スキャン + 更新の公開）:
  - `clawhub sync --all`

デフォルトでは、`clawhub` は現在の作業ディレクトリの `./skills` にインストールします
（または設定済みの OpenClaw ワークスペースにフォールバックします）。OpenClaw は
次のセッションからそれを `<workspace>/skills` として認識します。

## セキュリティに関する注意事項

- サードパーティのスキルは**信頼されないコード**として扱ってください。有効化する前に読んでください。
- 信頼されない入力やリスクのあるツールにはサンドボックス実行を優先してください。[サンドボックス](/gateway/sandboxing) を参照してください。
- `skills.entries.*.env` と `skills.entries.*.apiKey` はそのエージェントターンの**ホスト**プロセスにシークレットを注入します（サンドボックスではありません）。シークレットをプロンプトやログに含めないようにしてください。
- より広範な脅威モデルとチェックリストについては [セキュリティ](/gateway/security) を参照してください。

## フォーマット（AgentSkills + Pi 互換）

`SKILL.md` には少なくとも以下が必要です:

```markdown
---
name: nano-banana-pro
description: Generate or edit images via Gemini 3 Pro Image
---
```

注意事項:

- レイアウト・意図については AgentSkills スペックに従っています。
- 組み込みエージェントが使用するパーサーは**単一行**のフロントマターキーのみをサポートします。
- `metadata` は**単一行の JSON オブジェクト**である必要があります。
- スキルフォルダーパスを参照するには、手順に `{baseDir}` を使用してください。
- オプションのフロントマターキー:
  - `homepage` — macOS スキル UI で「Website」として表示される URL（`metadata.openclaw.homepage` 経由でもサポートされます）。
  - `user-invocable` — `true|false`（デフォルト: `true`）。`true` の場合、スキルはユーザーのスラッシュコマンドとして公開されます。
  - `disable-model-invocation` — `true|false`（デフォルト: `false`）。`true` の場合、スキルはモデルプロンプトから除外されます（ユーザー呼び出しは引き続き利用可能）。
  - `command-dispatch` — `tool`（オプション）。`tool` に設定すると、スラッシュコマンドはモデルをバイパスしてツールに直接ディスパッチされます。
  - `command-tool` — `command-dispatch: tool` が設定されている場合に呼び出すツール名。
  - `command-arg-mode` — `raw`（デフォルト）。ツールディスパッチの場合、生の args 文字列をツールに転送します（コアパースなし）。

    ツールは以下のパラメーターで呼び出されます:
    `{ command: "<raw args>", commandName: "<slash command>", skillName: "<skill name>" }`。

## ゲーティング（ロード時フィルター）

OpenClaw は `metadata`（単一行 JSON）を使用して**ロード時にスキルをフィルタリング**します:

```markdown
---
name: nano-banana-pro
description: Generate or edit images via Gemini 3 Pro Image
metadata:
  {
    "openclaw":
      {
        "requires": { "bins": ["uv"], "env": ["GEMINI_API_KEY"], "config": ["browser.enabled"] },
        "primaryEnv": "GEMINI_API_KEY",
      },
  }
---
```

`metadata.openclaw` の下のフィールド:

- `always: true` — スキルを常に含めます（他のゲートをスキップ）。
- `emoji` — macOS スキル UI が使用するオプションの絵文字。
- `homepage` — macOS スキル UI で「Website」として表示されるオプションの URL。
- `os` — オプションのプラットフォームリスト（`darwin`, `linux`, `win32`）。設定された場合、スキルはそれらの OS でのみ対象になります。
- `requires.bins` — リスト; 各バイナリが `PATH` 上に存在する必要があります。
- `requires.anyBins` — リスト; 少なくとも 1 つが `PATH` 上に存在する必要があります。
- `requires.env` — リスト; env 変数が存在するか、設定で提供される必要があります。
- `requires.config` — truthy である必要がある `openclaw.json` パスのリスト。
- `primaryEnv` — `skills.entries.<name>.apiKey` に関連する env 変数名。
- `install` — macOS スキル UI が使用するオプションのインストーラースペックの配列（brew/node/go/uv/download）。

サンドボックスに関する注意:

- `requires.bins` はスキルロード時に**ホスト**でチェックされます。
- エージェントがサンドボックス化されている場合、バイナリは**コンテナ内**にも存在する必要があります。
  `agents.defaults.sandbox.docker.setupCommand`（またはカスタムイメージ）でインストールしてください。
  `setupCommand` はコンテナが作成されるときに 1 度だけ実行されます。
  パッケージのインストールにはネットワーク出力、書き込み可能なルート FS、サンドボックス内の root ユーザーも必要です。
  例: `summarize` スキル（`skills/summarize/SKILL.md`）はそこで実行するためにサンドボックスコンテナ内に `summarize` CLI が必要です。

インストーラーの例:

```markdown
---
name: gemini
description: Use Gemini CLI for coding assistance and Google search lookups.
metadata:
  {
    "openclaw":
      {
        "emoji": "♊️",
        "requires": { "bins": ["gemini"] },
        "install":
          [
            {
              "id": "brew",
              "kind": "brew",
              "formula": "gemini-cli",
              "bins": ["gemini"],
              "label": "Install Gemini CLI (brew)",
            },
          ],
      },
  }
---
```

注意事項:

- 複数のインストーラーが列挙されている場合、gateway は**単一の**優先オプションを選択します（利用可能な場合は brew、それ以外は node）。
- すべてのインストーラーが `download` の場合、OpenClaw は利用可能なアーティファクトを確認できるように各エントリを一覧表示します。
- インストーラースペックには `os: ["darwin"|"linux"|"win32"]` を含めてプラットフォームでオプションをフィルタリングできます。
- Node インストールは `openclaw.json` の `skills.install.nodeManager`（デフォルト: npm; オプション: npm/pnpm/yarn/bun）に従います。
  これは**スキルインストール**のみに影響します。Gateway ランタイムは引き続き Node を使用してください
  （Bun は WhatsApp/Telegram には非推奨）。
- Go インストール: `go` が不足していて `brew` が利用可能な場合、gateway は最初に Homebrew 経由で Go をインストールし、可能な場合は `GOBIN` を Homebrew の `bin` に設定します。
- ダウンロードインストール: `url`（必須）、`archive`（`tar.gz` | `tar.bz2` | `zip`）、`extract`（デフォルト: アーカイブが検出された場合は自動）、`stripComponents`、`targetDir`（デフォルト: `~/.openclaw/tools/<skillKey>`）。

`metadata.openclaw` が存在しない場合、スキルは常に対象になります（設定で無効化されていないか、バンドルされたスキルの `skills.allowBundled` でブロックされていない限り）。

## 設定オーバーライド（`~/.openclaw/openclaw.json`）

バンドル・管理済みスキルのトグルと env 値の提供:

```json5
{
  skills: {
    entries: {
      "nano-banana-pro": {
        enabled: true,
        apiKey: { source: "env", provider: "default", id: "GEMINI_API_KEY" }, // またはプレーンテキスト文字列
        env: {
          GEMINI_API_KEY: "GEMINI_KEY_HERE",
        },
        config: {
          endpoint: "https://example.invalid",
          model: "nano-pro",
        },
      },
      peekaboo: { enabled: true },
      sag: { enabled: false },
    },
  },
}
```

注: スキル名にハイフンが含まれる場合はキーを引用符で囲んでください（JSON5 は引用符付きキーを許可します）。

設定キーはデフォルトで**スキル名**にマッチします。スキルが
`metadata.openclaw.skillKey` を定義している場合は、`skills.entries` の下でそのキーを使用してください。

ルール:

- `enabled: false`: バンドル・インストール済みであってもスキルを無効化します。
- `env`: プロセスに変数が設定されていない場合にのみ**注入**されます。
- `apiKey`: `metadata.openclaw.primaryEnv` を宣言するスキルの便利設定。
  プレーンテキスト文字列または SecretRef オブジェクト（`{ source, provider, id }`）をサポートします。
- `config`: カスタムのスキルごとのフィールド用のオプションのバッグ。カスタムキーはここに記述する必要があります。
- `allowBundled`: **バンドルされた**スキルのみのオプションのアローリスト。設定された場合、リスト内のバンドルされたスキルのみが対象になります（管理済み・ワークスペーススキルは影響を受けません）。

## 環境注入（エージェント実行ごと）

エージェント実行が開始されると、OpenClaw は:

1. スキルメタデータを読み取ります。
2. `skills.entries.<key>.env` または `skills.entries.<key>.apiKey` を `process.env` に適用します。
3. **対象**のスキルでシステムプロンプトを構築します。
4. 実行終了後に元の環境を復元します。

これはグローバルなシェル環境ではなく、**エージェント実行にスコープされています**。

## セッションスナップショット（パフォーマンス）

OpenClaw は**セッション開始時**に対象のスキルをスナップショットし、同一セッション内の後続のターンでそのリストを再利用します。スキルや設定への変更は次の新しいセッションで有効になります。

スキルウォッチャーが有効な場合、または新しい対象のリモートノードが表示された場合、スキルはセッション途中でも更新されることがあります（以下を参照）。これは**ホットリロード**と考えてください: 更新されたリストは次のエージェントターンで反映されます。

## リモート macOS ノード（Linux gateway）

Gateway が Linux で実行されているが、**macOS ノード**が**`system.run` が許可された状態で**接続されている場合（Exec approvals セキュリティが `deny` に設定されていない）、OpenClaw はそのノードに必要なバイナリが存在する場合、macOS 専用スキルを対象として扱うことができます。エージェントはそれらのスキルを `nodes` ツール（通常は `nodes.run`）経由で実行する必要があります。

これはノードがそのコマンドサポートを報告することと、`system.run` 経由のビンプローブに依存しています。macOS ノードが後でオフラインになった場合、スキルは引き続き表示されますが、ノードが再接続するまで呼び出しが失敗する可能性があります。

## スキルウォッチャー（自動更新）

デフォルトでは、OpenClaw はスキルフォルダーを監視し、`SKILL.md` ファイルが変更されるとスキルスナップショットを更新します。`skills.load` で設定してください:

```json5
{
  skills: {
    load: {
      watch: true,
      watchDebounceMs: 250,
    },
  },
}
```

## トークンへの影響（スキルリスト）

スキルが対象の場合、OpenClaw はコンパクトな XML スキルリストをシステムプロンプトに注入します（`pi-coding-agent` の `formatSkillsForPrompt` 経由）。コストは決定論的です:

- **ベースオーバーヘッド（1 つ以上のスキルがある場合のみ）:** 195 文字。
- **スキルごと:** 97 文字 + XML エスケープされた `<name>`、`<description>`、`<location>` 値の長さの合計。

計算式（文字数）:

```
total = 195 + Σ (97 + len(name_escaped) + len(description_escaped) + len(location_escaped))
```

注意事項:

- XML エスケープにより `& < > " '` がエンティティ（`&amp;`、`&lt;` など）に展開され、長さが増加します。
- トークン数はモデルトークナイザーによって異なります。OpenAI スタイルの大まかな見積もりは約 4 文字/トークンで、スキルごとに**97 文字 ≈ 24 トークン**（実際のフィールド長に加えて）です。

## 管理済みスキルのライフサイクル

OpenClaw はインストール（npm パッケージまたは OpenClaw.app）の一部として**バンドルされたスキル**のベースラインセットを提供します。`~/.openclaw/skills` はローカルオーバーライド用に存在します（バンドルされたコピーを変更せずにスキルをピン・パッチするなど）。ワークスペーススキルはユーザーが所有し、名前の競合時に両方を上書きします。

## 設定リファレンス

完全な設定スキーマについては [スキル設定](/tools/skills-config) を参照してください。

## スキルをもっと探していますか？

[https://clawhub.com](https://clawhub.com) をブラウズしてください。

---
