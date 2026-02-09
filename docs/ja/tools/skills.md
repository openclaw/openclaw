---
summary: "Skills：マネージドとワークスペースの違い、ゲーティングルール、設定／環境変数の連携"
read_when:
  - Skills の追加または変更
  - Skill のゲーティングやロードルールの変更
title: "Skills"
---

# Skills（OpenClaw）

OpenClaw は、エージェントにツールの使い方を教えるために **[AgentSkills](https://agentskills.io) 互換**の skill フォルダーを使用します。各 skill は、YAML フロントマターと手順を含む `SKILL.md` を持つディレクトリです。OpenClaw は **同梱 skills** に加えて任意のローカル上書きを読み込み、環境、設定、バイナリの存在に基づいてロード時にフィルタリングします。 各スキルは、 YAML frontmatter と instructions を含む `SKILL.md` ディレクトリです。 OpenClawは**バンドルされたスキル**とオプションのローカルオーバーライドをロードし、環境、config、バイナリの存在に基づいてロード時にそれらをフィルタします。

## 配置場所と優先順位

Skills は **3 か所**から読み込まれます。

1. **同梱 skills**：インストール（npm パッケージまたは OpenClaw.app）に同梱
2. **マネージド／ローカル skills**：`~/.openclaw/skills`
3. **ワークスペース skills**：`<workspace>/skills`

Skill 名が競合した場合の優先順位は次のとおりです。

`<workspace>/skills`（最優先）→ `~/.openclaw/skills` → 同梱 skills（最下位）

さらに、`~/.openclaw/openclaw.json` の `skills.load.extraDirs` で追加の skill フォルダー（最下位の優先順位）を設定できます。

## エージェント別と共有 skills

**マルチエージェント**構成では、各エージェントは独自のワークスペースを持ちます。つまり次のとおりです。 それは次のことを意味します:

- **エージェント別 skills** は、そのエージェント専用として `<workspace>/skills` に配置されます。
- **共有 skills** は `~/.openclaw/skills`（マネージド／ローカル）に配置され、同一マシン上の **すべてのエージェント** から参照できます。
- **共有フォルダー** は、複数エージェントで共通の skills パックを使いたい場合、`skills.load.extraDirs`（最下位の優先順位）でも追加できます。

同じ skill 名が複数の場所に存在する場合は、通常の優先順位が適用されます。ワークスペースが最優先、次にマネージド／ローカル、最後に同梱です。

## プラグインと skills

プラグインは、プラグインルートからの相対パスとして `openclaw.plugin.json` に `skills` ディレクトリを列挙することで、独自の skills を同梱できます。プラグインが有効になるとプラグイン skills がロードされ、通常の skill 優先順位ルールに参加します。プラグインの設定エントリの `metadata.openclaw.requires.config` によりゲートできます。検出／設定については [Plugins](/tools/plugin)、それらの skills が教えるツールの表面については [Tools](/tools) を参照してください。 プラグインのスキルは、プラグインが有効になっているときに
をロードし、通常のスキル優先ルールに参加します。
プラグインのconfig
エントリの `metadata.openclaw.requires.config` からゲートすることができます。 25. 検索や設定については [Plugins](/tools/plugin) を、
それらのスキルが提供するツールのサーフェスについては [Tools](/tools) を参照してください。

## ClawHub（インストール＋同期）

ClawHub は OpenClaw 向けの公開 skills レジストリです。閲覧は
[https://clawhub.com](https://clawhub.com) から行えます。Skills の発見、インストール、更新、バックアップに使用します。完全なガイドは [ClawHub](/tools/clawhub) を参照してください。
[https://clawhub.com](https://clawhub.com)を参照してください。 スキルの発見、インストール、更新、バックアップに使用します。
フルガイド: [ClawHub](/tools/clawhub).

一般的なフロー：

- ワークスペースに skill をインストール：
  - `clawhub install <skill-slug>`
- インストール済み skills をすべて更新：
  - `clawhub update --all`
- 同期（スキャン＋公開更新）：
  - `clawhub sync --all`

既定では、`clawhub` は現在の作業ディレクトリ配下の `./skills` にインストールします（または設定された OpenClaw ワークスペースにフォールバックします）。OpenClaw は次のセッションでそれを `<workspace>/skills` として認識します。 OpenClawは次のセッションで`
/skills`として<workspace>を選びます。

## セキュリティ上の注意

- サードパーティ製 skills は **信頼できないコード** として扱ってください。有効化する前に内容を確認してください。 有効にする前に読み込みます。
- 信頼できない入力やリスクの高いツールには、サンドボックス化された実行を優先してください。[Sandboxing](/gateway/sandboxing) を参照してください。 [Sandboxing](/gateway/sandboxing) を参照してください。
- `skills.entries.*.env` と `skills.entries.*.apiKey` は、そのエージェントのターンにおいて **ホスト** プロセスにシークレットを注入します（サンドボックスではありません）。シークレットをプロンプトやログに含めないでください。 プロンプトやログから秘密を守ります。
- より広範な脅威モデルとチェックリストについては [Security](/gateway/security) を参照してください。

## 形式（AgentSkills＋Pi 互換）

`SKILL.md` には、少なくとも次が含まれている必要があります。

```markdown
---
name: nano-banana-pro
description: Generate or edit images via Gemini 3 Pro Image
---
```

注記：

- レイアウト／意図については AgentSkills 仕様に従います。
- 組み込みエージェントが使用するパーサーは、**単一行**のフロントマターキーのみをサポートします。
- `metadata` は **単一行の JSON オブジェクト**である必要があります。
- 手順内で skill フォルダーパスを参照するには `{baseDir}` を使用してください。
- 任意のフロントマターキー：
  - `homepage` — macOS Skills UI に「Website」として表示される URL（`metadata.openclaw.homepage` でも対応）。
  - `user-invocable` — `true|false`（既定：`true`）。`true` の場合、skill はユーザーのスラッシュコマンドとして公開されます。 `true` の場合、スキルはユーザスラッシュコマンドとして公開されます。
  - `disable-model-invocation` — `true|false`（既定：`false`）。`true` の場合、skill はモデルプロンプトから除外されます（ユーザー呼び出しでは引き続き利用可能）。 `true` の場合、スキルはモデルプロンプトから除外されます (ユーザーが呼び出すことでも使用できます)。
  - `command-dispatch` — `tool` (オプション) `command-dispatch` — `tool`（任意）。`tool` に設定すると、スラッシュコマンドはモデルをバイパスして直接ツールにディスパッチされます。
  - `command-tool` — `command-dispatch: tool` が設定されている場合に呼び出すツール名。
  - `command-arg-mode` — `raw` (default). ツールディスパッチの場合、raw args 文字列をツールに転送します(コアパースなし)。

    ツールは次のパラメータで呼び出されます：
    `{ command: "<raw args>", commandName: "<slash command>", skillName: "<skill name>" }`。

## ゲーティング（ロード時フィルター）

OpenClaw は、`metadata`（単一行 JSON）を使用して **ロード時に skills をフィルタリング**します。

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

`metadata.openclaw` 配下のフィールド：

- `always: true` — 常に skill を含めます（他のゲートをスキップ）。
- `emoji` — macOS Skills UI で使用される任意の絵文字。
- `homepage` — macOS Skills UI に「Website」として表示される任意の URL。
- `os` — 任意のプラットフォーム一覧（`darwin`、`linux`、`win32`）。設定した場合、skill はそれらの OS のみで有効です。 設定されている場合、スキルはOSのみ対象となります。
- `requires.bins` — リスト。各項目は `PATH` 上に存在する必要があります。
- `requires.anyBins` — リスト。少なくとも 1 つが `PATH` 上に存在する必要があります。
- `requires.env` — リスト。環境変数が存在する **または** 設定で提供されている必要があります。
- `requires.config` — 真である必要がある `openclaw.json` パスのリスト。
- `primaryEnv` — `skills.entries.<name>.apiKey` に関連付けられた環境変数名。
- `install` — macOS Skills UI で使用されるインストーラ仕様の任意の配列（brew/node/go/uv/download）。

サンドボックスに関する注意：

- `requires.bins` は、skill のロード時に **ホスト** でチェックされます。
- エージェントがサンドボックス化されている場合、バイナリも **コンテナ内**に存在する必要があります。
  `agents.defaults.sandbox.docker.setupCommand` (またはカスタムイメージ)からインストールします。
  `setupCommand` はコンテナが作成された後に一度実行されます。
  パッケージのインストールには、ネットワーク egress、書き込み可能なルート FS 、および Sandbox 内の root ユーザも必要です。
  例: `summarize` skill (`skills/summarize/SKILL.md`) は Sandbox コンテナで `summarize` CLI
  を実行する必要があります。

インストーラ例：

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

注記：

- 複数のインストーラが列挙されている場合、ゲートウェイは **単一**の優先オプション（利用可能な場合は brew、そうでなければ node）を選択します。
- すべてのインストーラが `download` の場合、OpenClaw は利用可能なアーティファクトを確認できるよう各エントリを一覧表示します。
- インストーラ仕様には、プラットフォーム別にオプションをフィルタリングするための `os: ["darwin"|"linux"|"win32"]` を含めることができます。
- Node のインストールは、`openclaw.json` の `skills.install.nodeManager` を尊重します（既定：npm；選択肢：npm/pnpm/yarn/bun）。
  これは **skill のインストール**のみに影響します。Gateway ランタイムは引き続き Node である必要があります
  （WhatsApp/Telegram では Bun は推奨されません）。
  これは**スキルインストール**にのみ影響します。ゲートウェイランタイムはノード
  (WhatsApp/TelegramではBun は推奨されません)。
- Go のインストール：`go` が欠落しており `brew` が利用可能な場合、ゲートウェイは先に Homebrew で Go をインストールし、可能であれば `GOBIN` を Homebrew の `bin` に設定します。
- Download のインストール：`url`（必須）、`archive`（`tar.gz` | `tar.bz2` | `zip`）、`extract`（既定：アーカイブ検出時は自動）、`stripComponents`、`targetDir`（既定：`~/.openclaw/tools/<skillKey>`）。

`metadata.openclaw` が存在しない場合、その skill は常に有効です（設定で無効化されている場合、または同梱 skills に対する `skills.allowBundled` によりブロックされている場合を除く）。

## 設定による上書き（`~/.openclaw/openclaw.json`）

バンドルされた/管理されたスキルを切り替えてenv値を与えることができます:

```json5
{
  skills: {
    entries: {
      "nano-banana-pro": {
        enabled: true,
        apiKey: "GEMINI_KEY_HERE",
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

注：skill 名にハイフンが含まれる場合はキーをクォートしてください（JSON5 ではクォート付きキーが許可されています）。

設定キーはデフォルトで **skill name** と一致します。 設定キーは既定で **skill 名**と一致します。skill が `metadata.openclaw.skillKey` を定義している場合は、`skills.entries` 配下でそのキーを使用してください。

ルール：

- `enabled: false` は、同梱／インストール済みであっても skill を無効化します。
- `env`：その変数がプロセス内ですでに設定されていない場合に **のみ** 注入されます。
- `apiKey`：`metadata.openclaw.primaryEnv` を宣言する skills 向けの簡便機能です。
- `config`：カスタムの skill ごとのフィールドを入れる任意の入れ物です。カスタムキーはここに配置する必要があります。
- `allowBundled`：**同梱** skills のみを対象とした任意の許可リスト。設定されている場合、リスト内の同梱 skills のみが有効になります（マネージド／ワークスペース skills には影響しません）。 設定されている場合、リスト内の
  バンドルされたスキルのみが対象となります(管理スキル/ワークスペーススキルは影響を受けません)。

## 環境変数の注入（エージェント実行ごと）

エージェント実行が開始されると、OpenClaw は次を行います。

1. Skill メタデータを読み取ります。
2. `skills.entries.<key>.env` または `skills.entries.<key>.apiKey` を `process.env` に適用します。
3. **有効な** skills を用いてシステムプロンプトを構築します。
4. 実行終了後、元の環境を復元します。

これは **エージェント実行にスコープ**されたものであり、グローバルなシェル環境ではありません。

## セッションスナップショット（パフォーマンス）

OpenClaw は、**セッション開始時**に有効な skills をスナップショットし、同一セッション内の後続ターンでその一覧を再利用します。Skills や設定の変更は、次の新しいセッションから有効になります。 スキルや設定の変更は、次の新しいセッションで有効になります。

スキルは、スキルウォッチャーが有効になっている場合や、新しい対象となるリモートノードが表示された場合(下記参照)にも、セッション中にリフレッシュすることができます。 **ホットリロード**と考えてみてください。リフレッシュされたリストは、次のエージェントターンでピックアップされます。

## リモート macOS ノード（Linux Gateway）

Gateway（ゲートウェイ）が Linux 上で稼働しており、**macOS ノード**が **`system.run` を許可した状態**（Exec approvals のセキュリティが `deny` に設定されていない）で接続されている場合、OpenClaw は必要なバイナリがそのノード上に存在すれば、macOS 専用 skills を有効として扱えます。エージェントは、それらの skills を `nodes` ツール（通常は `nodes.run`）経由で実行する必要があります。 エージェントは `nodes` ツール(通常 `nodes.run`)を使用してこれらのスキルを実行します。

これは `system.run` を介してコマンドサポートとビンプローブを報告するノードに依存します。 これは、ノードがコマンド対応状況を報告し、`system.run` による bin プローブに依存します。後で macOS ノードがオフラインになっても skills は表示されたままですが、再接続されるまで呼び出しが失敗する可能性があります。

## Skills ウォッチャー（自動更新）

既定では、OpenClaw は skill フォルダーを監視し、`SKILL.md` ファイルが変更されると skills スナップショットを更新します。`skills.load` で設定します。 これを `skills.load` で設定します。

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

## トークンへの影響（skills 一覧）

Skills が有効な場合、OpenClaw は利用可能な skills のコンパクトな XML 一覧をシステムプロンプトに注入します（`pi-coding-agent` の `formatSkillsForPrompt` 経由）。コストは決定的です。 コストは決定的です:

- **ベースのオーバーヘッド（1 つ以上の skill がある場合のみ）：** 195 文字。
- **Skill あたり：** 97 文字 ＋ XML エスケープされた `<name>`、`<description>`、`<location>` の長さ。

式（文字数）：

```
total = 195 + Σ (97 + len(name_escaped) + len(description_escaped) + len(location_escaped))
```

注記：

- XML エスケープにより `& < > " '` はエンティティ（`&amp;`、`&lt;` など）に展開され、長さが増加します。
- トークン数はモデルトークナイザーによって異なります。 トークン数はモデルのトークナイザーによって異なります。OpenAI 風の概算では約 4 文字／トークンのため、**97 文字 ≈ 24 トークン**／skill に、実際のフィールド長が加算されます。

## マネージド skills のライフサイクル

OpenClawは、
インストール (npm パッケージまたはOpenClaw.app) の一部として、**バンドルスキル** としてスキルのベースラインセットを出荷します。 `~/.openclaw/skills` はローカルの
オーバーライドに存在します (例えば、バンドルされた
コピーを変更せずにスキルをピン留め/パッチするなど)。 ワークスペースのスキルはユーザーが所有し、名前の競合の両方を上書きします。

## 設定リファレンス

完全な設定スキーマについては [Skills config](/tools/skills-config) を参照してください。

## さらに skills を探していますか？

[https://clawhub.com](https://clawhub.com) を参照してください。

---
