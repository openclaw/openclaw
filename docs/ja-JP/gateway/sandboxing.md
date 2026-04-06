---
summary: "OpenClaw サンドボックスの仕組み: モード、スコープ、ワークスペースアクセス、イメージ"
title: サンドボックス
read_when: "サンドボックスの専用説明が必要なとき、または agents.defaults.sandbox を調整したいとき。"
status: active
x-i18n:
    generated_at: "2026-04-03T00:00:00Z"
    model: claude-sonnet-4-6
    provider: anthropic
    source_hash: 2acfc7b8f2873c6dae5bdbcc858fcc5756d5ef20ce1b0907fa09c3d11f5387e3
    source_path: gateway/sandboxing.md
    workflow: 15
---

# サンドボックス

OpenClaw は**サンドボックスバックエンド内でツールを実行**して、影響範囲を縮小できます。
これは**オプション**で、設定（`agents.defaults.sandbox` または
`agents.list[].sandbox`）によって制御されます。サンドボックスがオフの場合、ツールはホスト上で実行されます。
Gateway ゲートウェイはホスト上に留まります。有効にすると、ツール実行は分離されたサンドボックスで行われます。

これは完全なセキュリティ境界ではありませんが、モデルが何か問題を起こした場合にファイルシステムとプロセスへのアクセスを実質的に制限します。

## サンドボックス化される対象

- ツール実行（`exec`、`read`、`write`、`edit`、`apply_patch`、`process` など）。
- オプションのサンドボックスブラウザ（`agents.defaults.sandbox.browser`）。
  - デフォルトでは、ブラウザツールが必要とする場合、サンドボックスブラウザは自動起動します（CDP が到達可能であることを保証します）。
    `agents.defaults.sandbox.browser.autoStart` および `agents.defaults.sandbox.browser.autoStartTimeoutMs` で設定できます。
  - デフォルトでは、サンドボックスブラウザコンテナはグローバルの `bridge` ネットワークの代わりに専用の Docker ネットワーク（`openclaw-sandbox-browser`）を使用します。
    `agents.defaults.sandbox.browser.network` で設定できます。
  - オプションの `agents.defaults.sandbox.browser.cdpSourceRange` は CIDR アローリスト（例: `172.21.0.1/32`）でコンテナ側の CDP 入力を制限します。
  - noVNC オブザーバーアクセスはデフォルトでパスワード保護されています。OpenClaw はローカルブートストラップページを提供し、URL フラグメントにパスワードを含む形で noVNC を開く短命のトークン URL を発行します（クエリ/ヘッダーのログには含まれません）。
  - `agents.defaults.sandbox.browser.allowHostControl` はサンドボックス化されたセッションがホストブラウザを明示的にターゲットにできるようにします。
  - オプションのアローリストが `target: "custom"` をゲートします: `allowedControlUrls`、`allowedControlHosts`、`allowedControlPorts`。

サンドボックス化されない対象:

- Gateway ゲートウェイプロセス自体。
- ホスト上での実行が明示的に許可されたツール（例: `tools.elevated`）。
  - **Elevated exec はホスト上で実行され、サンドボックスをバイパスします。**
  - サンドボックスがオフの場合、`tools.elevated` は実行を変更しません（すでにホスト上にあるため）。[Elevated モード](/tools/elevated) を参照してください。

## モード

`agents.defaults.sandbox.mode` はサンドボックスが**いつ**使用されるかを制御します:

- `"off"`: サンドボックスなし。
- `"non-main"`: **非メイン**セッションのみサンドボックス化（通常のチャットをホスト上で行いたい場合のデフォルト）。
- `"all"`: すべてのセッションがサンドボックスで実行されます。
  注: `"non-main"` はエージェント ID ではなく `session.mainKey`（デフォルト `"main"`）に基づきます。
  グループ/チャンネルセッションは独自のキーを使用するため、非メインとしてカウントされ、サンドボックス化されます。

## スコープ

`agents.defaults.sandbox.scope` は**何個のコンテナ**が作成されるかを制御します:

- `"agent"`（デフォルト）: エージェントごとに 1 つのコンテナ。
- `"session"`: セッションごとに 1 つのコンテナ。
- `"shared"`: すべてのサンドボックス化されたセッションで共有される 1 つのコンテナ。

## バックエンド

`agents.defaults.sandbox.backend` はサンドボックスを提供する**ランタイム**を制御します:

- `"docker"`（デフォルト）: ローカル Docker バックエンドのサンドボックスランタイム。
- `"ssh"`: 汎用 SSH バックエンドのリモートサンドボックスランタイム。
- `"openshell"`: OpenShell バックエンドのサンドボックスランタイム。

SSH 固有の設定は `agents.defaults.sandbox.ssh` にあります。
OpenShell 固有の設定は `plugins.entries.openshell.config` にあります。

### バックエンドの選択

|                     | Docker                           | SSH                            | OpenShell                                           |
| ------------------- | -------------------------------- | ------------------------------ | --------------------------------------------------- |
| **実行場所**   | ローカルコンテナ                  | SSH でアクセス可能な任意のホスト        | OpenShell 管理サンドボックス                           |
| **セットアップ**           | `scripts/sandbox-setup.sh`       | SSH キー + ターゲットホスト          | OpenShell プラグインが有効                            |
| **ワークスペースモデル** | バインドマウントまたはコピー               | リモート正規（1 回シード）   | `mirror` または `remote`                                |
| **ネットワーク制御** | `docker.network`（デフォルト: なし） | リモートホストに依存         | OpenShell に依存                                |
| **ブラウザサンドボックス** | サポート                        | 非サポート                  | 未サポート                                   |
| **バインドマウント**     | `docker.binds`                   | 非対応                            | 非対応                            |
| **最適用途**        | ローカル開発、完全な分離        | リモートマシンへのオフロード | オプションの双方向同期付きマネージドリモートサンドボックス |

### SSH バックエンド

任意の SSH でアクセス可能なマシン上で OpenClaw に `exec`、ファイルツール、メディア読み取りをサンドボックス化させたい場合は `backend: "ssh"` を使用します。

```json5
{
  agents: {
    defaults: {
      sandbox: {
        mode: "all",
        backend: "ssh",
        scope: "session",
        workspaceAccess: "rw",
        ssh: {
          target: "user@gateway-host:22",
          workspaceRoot: "/tmp/openclaw-sandboxes",
          strictHostKeyChecking: true,
          updateHostKeys: true,
          identityFile: "~/.ssh/id_ed25519",
          certificateFile: "~/.ssh/id_ed25519-cert.pub",
          knownHostsFile: "~/.ssh/known_hosts",
          // または SecretRefs / インラインコンテンツをローカルファイルの代わりに使用:
          // identityData: { source: "env", provider: "default", id: "SSH_IDENTITY" },
          // certificateData: { source: "env", provider: "default", id: "SSH_CERTIFICATE" },
          // knownHostsData: { source: "env", provider: "default", id: "SSH_KNOWN_HOSTS" },
        },
      },
    },
  },
}
```

仕組み:

- OpenClaw は `sandbox.ssh.workspaceRoot` の下にスコープごとのリモートルートを作成します。
- 作成または再作成後の初回使用時に、OpenClaw はそのリモートワークスペースをローカルワークスペースから 1 回シードします。
- その後、`exec`、`read`、`write`、`edit`、`apply_patch`、プロンプトのメディア読み取り、インバウンドメディアのステージングが SSH 経由でリモートワークスペースに対して直接実行されます。
- OpenClaw はリモートの変更をローカルワークスペースに自動的に同期しません。

認証資材:

- `identityFile`、`certificateFile`、`knownHostsFile`: 既存のローカルファイルを使用し、OpenSSH 設定を通じて渡します。
- `identityData`、`certificateData`、`knownHostsData`: インライン文字列または SecretRefs を使用します。OpenClaw は通常のシークレットランタイムスナップショットを通じてそれらを解決し、`0600` のパーミッションで一時ファイルに書き込み、SSH セッション終了時に削除します。
- 同じアイテムに `*File` と `*Data` の両方が設定されている場合、その SSH セッションでは `*Data` が優先されます。

これは**リモート正規**モデルです。リモート SSH ワークスペースは初期シード後に実際のサンドボックスの状態になります。

重要な影響:

- シードステップ後に OpenClaw 外でホストローカルに行われた編集は、サンドボックスを再作成するまでリモートには反映されません。
- `openclaw sandbox recreate` はスコープごとのリモートルートを削除し、次回の使用時にローカルから再シードします。
- SSH バックエンドではブラウザサンドボックスはサポートされていません。
- `sandbox.docker.*` の設定は SSH バックエンドには適用されません。

### OpenShell バックエンド

OpenShell が管理するリモート環境でツールをサンドボックス化したい場合は `backend: "openshell"` を使用します。
フルセットアップガイド、設定リファレンス、ワークスペースモードの比較については、専用の
[OpenShell ページ](/gateway/openshell) を参照してください。

OpenShell は汎用 SSH バックエンドと同じコア SSH トランスポートとリモートファイルシステムブリッジを再利用し、
OpenShell 固有のライフサイクル（`sandbox create/get/delete`、`sandbox ssh-config`）とオプションの `mirror`
ワークスペースモードを追加します。

```json5
{
  agents: {
    defaults: {
      sandbox: {
        mode: "all",
        backend: "openshell",
        scope: "session",
        workspaceAccess: "rw",
      },
    },
  },
  plugins: {
    entries: {
      openshell: {
        enabled: true,
        config: {
          from: "openclaw",
          mode: "remote", // mirror | remote
          remoteWorkspaceDir: "/sandbox",
          remoteAgentWorkspaceDir: "/agent",
        },
      },
    },
  },
}
```

OpenShell モード:

- `mirror`（デフォルト）: ローカルワークスペースが正規のままです。OpenClaw は exec 前にローカルファイルを OpenShell に同期し、exec 後にリモートワークスペースを同期します。
- `remote`: サンドボックス作成後は OpenShell ワークスペースが正規になります。OpenClaw はリモートワークスペースをローカルワークスペースから 1 回シードし、その後ファイルツールと exec はリモートサンドボックスに対して直接実行されます（変更を同期して戻すことはしません）。

リモートトランスポートの詳細:

- OpenClaw は `openshell sandbox ssh-config <name>` を通じて OpenShell にサンドボックス固有の SSH 設定を要求します。
- コアはその SSH 設定を一時ファイルに書き込み、SSH セッションを開き、`backend: "ssh"` で使用されるものと同じリモートファイルシステムブリッジを再利用します。
- `mirror` モードではライフサイクルのみが異なります: exec 前にローカルからリモートに同期し、exec 後に同期して戻します。

現在の OpenShell の制限:

- サンドボックスブラウザはまだサポートされていません
- `sandbox.docker.binds` は OpenShell バックエンドでサポートされていません
- `sandbox.docker.*` の下の Docker 固有のランタイムノブは引き続き Docker バックエンドにのみ適用されます

#### ワークスペースモード

OpenShell には 2 つのワークスペースモデルがあります。実際に最も重要な部分はここです。

##### `mirror`

ローカルワークスペースを**正規のままにしたい**場合は `plugins.entries.openshell.config.mode: "mirror"` を使用します。

動作:

- `exec` の前に、OpenClaw はローカルワークスペースを OpenShell サンドボックスに同期します。
- `exec` の後に、OpenClaw はリモートワークスペースをローカルワークスペースに同期します。
- ファイルツールは引き続きサンドボックスブリッジを通じて動作しますが、ターン間ではローカルワークスペースが信頼できる情報源のままです。

次の場合に使用します:

- OpenClaw の外でローカルにファイルを編集し、その変更をサンドボックスに自動的に反映させたい場合
- OpenShell サンドボックスを Docker バックエンドと可能な限り同様に動作させたい場合
- exec の各ターン後にホストワークスペースにサンドボックスへの書き込みを反映させたい場合

トレードオフ:

- exec の前後に余分な同期コストが発生します

##### `remote`

**OpenShell ワークスペースを正規にしたい**場合は `plugins.entries.openshell.config.mode: "remote"` を使用します。

動作:

- サンドボックスが最初に作成されると、OpenClaw はリモートワークスペースをローカルワークスペースから 1 回シードします。
- その後、`exec`、`read`、`write`、`edit`、`apply_patch` はリモート OpenShell ワークスペースに対して直接動作します。
- OpenClaw は exec 後にリモートの変更をローカルワークスペースに**同期しません**。
- プロンプト時のメディア読み取りは、ファイルとメディアツールがローカルホストパスを想定するのではなくサンドボックスブリッジを通じて読み取るため、引き続き機能します。
- トランスポートは `openshell sandbox ssh-config` が返す OpenShell サンドボックスへの SSH です。

重要な影響:

- シードステップ後に OpenClaw 外でホスト上のファイルを編集した場合、リモートサンドボックスはそれらの変更を自動的には**認識しません**。
- サンドボックスが再作成されると、リモートワークスペースはローカルワークスペースから再度シードされます。
- `scope: "agent"` または `scope: "shared"` の場合、そのリモートワークスペースは同じスコープで共有されます。

次の場合に使用します:

- サンドボックスが主にリモートの OpenShell 側に存在すべき場合
- ターンごとの同期オーバーヘッドを低くしたい場合
- ホストローカルの編集がリモートサンドボックスの状態を暗黙的に上書きしないようにしたい場合

サンドボックスを一時的な実行環境と考える場合は `mirror` を選択します。
サンドボックスを実際のワークスペースと考える場合は `remote` を選択します。

#### OpenShell のライフサイクル

OpenShell サンドボックスは通常のサンドボックスライフサイクルを通じて管理されます:

- `openclaw sandbox list` は Docker ランタイムと同様に OpenShell ランタイムも表示します
- `openclaw sandbox recreate` は現在のランタイムを削除し、次回の使用時に OpenClaw が再作成できるようにします
- プルーンロジックもバックエンドを認識しています

`remote` モードでは、recreate が特に重要です:

- recreate はそのスコープの正規のリモートワークスペースを削除します
- 次の使用時にローカルワークスペースから新しいリモートワークスペースをシードします

`mirror` モードでは、recreate は主にリモート実行環境をリセットします。
ローカルワークスペースが引き続き正規であるためです。

## ワークスペースアクセス

`agents.defaults.sandbox.workspaceAccess` はサンドボックスが**何を参照できるか**を制御します:

- `"none"`（デフォルト）: ツールは `~/.openclaw/sandboxes` の下のサンドボックスワークスペースを参照します。
- `"ro"`: エージェントワークスペースを `/agent` に読み取り専用でマウントします（`write`/`edit`/`apply_patch` を無効化）。
- `"rw"`: エージェントワークスペースを `/workspace` に読み書き可能でマウントします。

OpenShell バックエンドの場合:

- `mirror` モードでは exec ターン間ではローカルワークスペースが引き続き正規のソースとして使用されます
- `remote` モードでは初期シード後はリモート OpenShell ワークスペースが正規のソースとして使用されます
- `workspaceAccess: "ro"` および `"none"` は同じ方法で書き込み動作を制限します

インバウンドメディアはアクティブなサンドボックスワークスペース（`media/inbound/*`）にコピーされます。
スキルの注意: `read` ツールはサンドボックスをルートとしています。`workspaceAccess: "none"` の場合、
OpenClaw は対象のスキルをサンドボックスワークスペース（`.../skills`）にミラーリングして
読み取れるようにします。`"rw"` の場合、ワークスペーススキルは
`/workspace/skills` から読み取り可能です。

## カスタムバインドマウント

`agents.defaults.sandbox.docker.binds` はホストディレクトリをコンテナに追加マウントします。
形式: `host:container:mode`（例: `"/home/user/source:/source:rw"`）。

グローバルとエージェントごとのバインドは**マージ**されます（置き換えではありません）。`scope: "shared"` では、エージェントごとのバインドは無視されます。

`agents.defaults.sandbox.browser.binds` はホストディレクトリを**サンドボックスブラウザ**コンテナのみに追加マウントします。

- 設定された場合（`[]` を含む）、ブラウザコンテナの `agents.defaults.sandbox.docker.binds` を置き換えます。
- 省略された場合、ブラウザコンテナは `agents.defaults.sandbox.docker.binds` にフォールバックします（後方互換性あり）。

例（読み取り専用ソース + 追加データディレクトリ）:

```json5
{
  agents: {
    defaults: {
      sandbox: {
        docker: {
          binds: ["/home/user/source:/source:ro", "/var/data/myapp:/data:ro"],
        },
      },
    },
    list: [
      {
        id: "build",
        sandbox: {
          docker: {
            binds: ["/mnt/cache:/cache:rw"],
          },
        },
      },
    ],
  },
}
```

セキュリティに関する注意:

- バインドはサンドボックスのファイルシステムをバイパスします: 設定したモード（`:ro` または `:rw`）でホストパスを露出します。
- OpenClaw は危険なバインドソースをブロックします（例: `docker.sock`、`/etc`、`/proc`、`/sys`、`/dev`、およびそれらを露出する親マウント）。
- 機密マウント（シークレット、SSH キー、サービス認証情報）は絶対に必要でない限り `:ro` にするべきです。
- ワークスペースへの読み取りアクセスのみが必要な場合は `workspaceAccess: "ro"` と組み合わせてください。バインドモードは独立したままです。
- バインドがツールポリシーと elevated exec とどのように相互作用するかについては [サンドボックス vs ツールポリシー vs Elevated](/gateway/sandbox-vs-tool-policy-vs-elevated) を参照してください。

## イメージとセットアップ

デフォルト Docker イメージ: `openclaw-sandbox:bookworm-slim`

1 度ビルドします:

```bash
scripts/sandbox-setup.sh
```

注: デフォルトイメージには Node が**含まれていません**。スキルに Node（または
その他のランタイム）が必要な場合は、カスタムイメージをビルドするか、
`sandbox.docker.setupCommand` でインストールしてください（ネットワーク出力 + 書き込み可能なルート +
root ユーザーが必要です）。

一般的なツール（例: `curl`、`jq`、`nodejs`、`python3`、`git`）を含むより機能的なサンドボックスイメージが必要な場合は、次をビルドします:

```bash
scripts/sandbox-common-setup.sh
```

その後、`agents.defaults.sandbox.docker.image` を
`openclaw-sandbox-common:bookworm-slim` に設定します。

サンドボックスブラウザイメージ:

```bash
scripts/sandbox-browser-setup.sh
```

デフォルトでは、Docker サンドボックスコンテナは**ネットワークなし**で実行されます。
`agents.defaults.sandbox.docker.network` でオーバーライドします。

バンドルされたサンドボックスブラウザイメージは、コンテナ化されたワークロード向けに保守的な Chromium スタートアップデフォルトも適用します。
現在のコンテナデフォルトには以下が含まれます:

- `--remote-debugging-address=127.0.0.1`
- `--remote-debugging-port=<OPENCLAW_BROWSER_CDP_PORT から派生>`
- `--user-data-dir=${HOME}/.chrome`
- `--no-first-run`
- `--no-default-browser-check`
- `--disable-3d-apis`
- `--disable-gpu`
- `--disable-dev-shm-usage`
- `--disable-background-networking`
- `--disable-extensions`
- `--disable-features=TranslateUI`
- `--disable-breakpad`
- `--disable-crash-reporter`
- `--disable-software-rasterizer`
- `--no-zygote`
- `--metrics-recording-only`
- `--renderer-process-limit=2`
- `noSandbox` が有効な場合の `--no-sandbox` および `--disable-setuid-sandbox`。
- 3 つのグラフィックスハードニングフラグ（`--disable-3d-apis`、
  `--disable-software-rasterizer`、`--disable-gpu`）はオプションで、
  コンテナに GPU サポートがない場合に有用です。ワークロードに WebGL やその他の 3D/ブラウザ機能が必要な場合は
  `OPENCLAW_BROWSER_DISABLE_GRAPHICS_FLAGS=0` を設定してください。
- `--disable-extensions` はデフォルトで有効で、拡張機能を使うフローには
  `OPENCLAW_BROWSER_DISABLE_EXTENSIONS=0` で無効にできます。
- `--renderer-process-limit=2` は
  `OPENCLAW_BROWSER_RENDERER_PROCESS_LIMIT=<N>` で制御されます。`0` にすると Chromium のデフォルトが維持されます。

異なるランタイムプロファイルが必要な場合は、カスタムブラウザイメージを使用して
独自のエントリポイントを提供してください。ローカル（コンテナではない）の Chromium プロファイルには、
`browser.extraArgs` を使用して追加のスタートアップフラグを追加します。

セキュリティのデフォルト:

- `network: "host"` はブロックされています。
- `network: "container:<id>"` はデフォルトでブロックされています（名前空間結合バイパスリスク）。
- ブレークグラスオーバーライド: `agents.defaults.sandbox.docker.dangerouslyAllowContainerNamespaceJoin: true`。

Docker インストールとコンテナ化された Gateway ゲートウェイはここにあります:
[Docker](/install/docker)

Docker Gateway ゲートウェイデプロイメントでは、`scripts/docker/setup.sh` がサンドボックス設定をブートストラップできます。
そのパスを有効にするには `OPENCLAW_SANDBOX=1`（または `true`/`yes`/`on`）を設定します。
`OPENCLAW_DOCKER_SOCKET` でソケットの場所をオーバーライドできます。フルセットアップと環境
リファレンス: [Docker](/install/docker#agent-sandbox)。

## setupCommand（1 回限りのコンテナセットアップ）

`setupCommand` はサンドボックスコンテナが作成された後に**1 回**実行されます（実行ごとではありません）。
コンテナ内で `sh -lc` を通じて実行されます。

パス:

- グローバル: `agents.defaults.sandbox.docker.setupCommand`
- エージェントごと: `agents.list[].sandbox.docker.setupCommand`

よくある落とし穴:

- デフォルトの `docker.network` は `"none"`（出力なし）なので、パッケージインストールは失敗します。
- `docker.network: "container:<id>"` は `dangerouslyAllowContainerNamespaceJoin: true` が必要で、ブレークグラスのみです。
- `readOnlyRoot: true` は書き込みを禁止します。`readOnlyRoot: false` を設定するかカスタムイメージをビルドします。
- パッケージインストールには `user` が root である必要があります（`user` を省略するか `user: "0:0"` を設定）。
- サンドボックス exec はホストの `process.env` を**継承しません**。スキル API キーには
  `agents.defaults.sandbox.docker.env`（またはカスタムイメージ）を使用します。

## ツールポリシーとエスケープハッチ

ツールの許可/拒否ポリシーはサンドボックスルールの前に適用されます。ツールが
グローバルまたはエージェントごとに拒否されている場合、サンドボックスはそれを元に戻しません。

`tools.elevated` はホスト上で `exec` を実行する明示的なエスケープハッチです。
`/exec` ディレクティブは認証された送信者にのみ適用され、セッションごとに持続します。`exec` を完全に無効にするには、
ツールポリシーの拒否を使用します（[サンドボックス vs ツールポリシー vs Elevated](/gateway/sandbox-vs-tool-policy-vs-elevated) を参照）。

デバッグ:

- `openclaw sandbox explain` を使用して有効なサンドボックスモード、ツールポリシー、修正設定キーを検査します。
- 「これがブロックされているのはなぜか?」というメンタルモデルについては [サンドボックス vs ツールポリシー vs Elevated](/gateway/sandbox-vs-tool-policy-vs-elevated) を参照してください。
  ロックダウンを維持してください。

## マルチエージェントのオーバーライド

各エージェントはサンドボックス + ツールをオーバーライドできます:
`agents.list[].sandbox` と `agents.list[].tools`（サンドボックスツールポリシーには `agents.list[].tools.sandbox.tools`）。
優先順位については [マルチエージェントサンドボックスとツール](/tools/multi-agent-sandbox-tools) を参照してください。

## 最小有効化の例

```json5
{
  agents: {
    defaults: {
      sandbox: {
        mode: "non-main",
        scope: "session",
        workspaceAccess: "none",
      },
    },
  },
}
```

## 関連ドキュメント

- [OpenShell](/gateway/openshell) -- マネージドサンドボックスバックエンドのセットアップ、ワークスペースモード、設定リファレンス
- [サンドボックス設定](/gateway/configuration-reference#agentsdefaultssandbox)
- [サンドボックス vs ツールポリシー vs Elevated](/gateway/sandbox-vs-tool-policy-vs-elevated) -- 「これがブロックされているのはなぜか?」のデバッグ
- [マルチエージェントサンドボックスとツール](/tools/multi-agent-sandbox-tools) -- エージェントごとのオーバーライドと優先順位
- [セキュリティ](/gateway/security)
