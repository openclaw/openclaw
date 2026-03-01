---
summary: "OpenClawのサンドボックスの仕組み：モード、スコープ、ワークスペースアクセス、イメージ"
title: "サンドボックス"
read_when: "You want a dedicated explanation of sandboxing or need to tune agents.defaults.sandbox."
status: active
---

# サンドボックス

OpenClawは影響範囲を減らすために**Dockerコンテナ内でツールを実行**できます。
これは**オプション**であり、設定（`agents.defaults.sandbox`または`agents.list[].sandbox`）で制御されます。サンドボックスがオフの場合、ツールはホスト上で実行されます。
Gatewayはホスト上に留まります。有効な場合、ツールの実行は分離されたサンドボックスで行われます。

これは完全なセキュリティ境界ではありませんが、モデルが何か愚かなことをした場合にファイルシステムとプロセスアクセスを実質的に制限します。

## サンドボックス化されるもの

- ツールの実行（`exec`、`read`、`write`、`edit`、`apply_patch`、`process`など）。
- オプションのサンドボックスブラウザ（`agents.defaults.sandbox.browser`）。
  - デフォルトでは、ブラウザツールが必要とする場合、サンドボックスブラウザが自動起動します（CDPが到達可能であることを保証）。
    `agents.defaults.sandbox.browser.autoStart`と`agents.defaults.sandbox.browser.autoStartTimeoutMs`で設定します。
  - デフォルトでは、サンドボックスブラウザコンテナはグローバルな`bridge`ネットワークの代わりに専用のDockerネットワーク（`openclaw-sandbox-browser`）を使用します。
    `agents.defaults.sandbox.browser.network`で設定します。
  - オプションの`agents.defaults.sandbox.browser.cdpSourceRange`はCIDR許可リストでコンテナエッジのCDPイングレスを制限します（例：`172.21.0.1/32`）。
  - noVNCオブザーバーアクセスはデフォルトでパスワード保護されています。OpenClawはオブザーバーセッションに解決される短命のトークンURLを発行します。
  - `agents.defaults.sandbox.browser.allowHostControl`は、サンドボックスセッションがホストブラウザを明示的にターゲットできるようにします。
  - オプションの許可リストが`target: "custom"`をゲートします：`allowedControlUrls`、`allowedControlHosts`、`allowedControlPorts`。

サンドボックス化されないもの：

- Gatewayプロセス自体。
- ホスト上で実行することが明示的に許可されたツール（例：`tools.elevated`）。
  - **Elevated execはホスト上で実行され、サンドボックスをバイパスします。**
  - サンドボックスがオフの場合、`tools.elevated`は実行を変更しません（すでにホスト上）。[Elevatedモード](/tools/elevated)を参照してください。

## モード

`agents.defaults.sandbox.mode`はサンドボックスが**いつ**使用されるかを制御します：

- `"off"`：サンドボックスなし。
- `"non-main"`：**非main**セッションのみをサンドボックス化（通常チャットをホスト上で行いたい場合のデフォルト）。
- `"all"`：すべてのセッションがサンドボックスで実行されます。
  注意：`"non-main"`は`session.mainKey`（デフォルト`"main"`）に基づいており、エージェントIDではありません。
  グループ/チャンネルセッションは独自のキーを使用するため、非mainとしてカウントされサンドボックス化されます。

## スコープ

`agents.defaults.sandbox.scope`は**いくつのコンテナ**が作成されるかを制御します：

- `"session"`（デフォルト）：セッションごとに1つのコンテナ。
- `"agent"`：エージェントごとに1つのコンテナ。
- `"shared"`：すべてのサンドボックスセッションで共有される1つのコンテナ。

## ワークスペースアクセス

`agents.defaults.sandbox.workspaceAccess`はサンドボックスが**何を見れるか**を制御します：

- `"none"`（デフォルト）：ツールは`~/.openclaw/sandboxes`配下のサンドボックスワークスペースを参照します。
- `"ro"`：エージェントワークスペースを`/agent`に読み取り専用でマウント（`write`/`edit`/`apply_patch`を無効化）。
- `"rw"`：エージェントワークスペースを`/workspace`に読み書き可能でマウント。

受信メディアはアクティブなサンドボックスワークスペース（`media/inbound/*`）にコピーされます。
スキルに関する注意：`read`ツールはサンドボックスルートです。`workspaceAccess: "none"`の場合、OpenClawは対象のスキルをサンドボックスワークスペース（`.../skills`）にミラーリングして読み取れるようにします。`"rw"`の場合、ワークスペースのスキルは`/workspace/skills`から読み取れます。

## カスタムバインドマウント

`agents.defaults.sandbox.docker.binds`は追加のホストディレクトリをコンテナにマウントします。
形式：`host:container:mode`（例：`"/home/user/source:/source:rw"`）。

グローバルとエージェントごとのバインドは**マージ**されます（置換されません）。`scope: "shared"`では、エージェントごとのバインドは無視されます。

`agents.defaults.sandbox.browser.binds`は追加のホストディレクトリを**サンドボックスブラウザ**コンテナのみにマウントします。

- 設定されている場合（`[]`を含む）、ブラウザコンテナの`agents.defaults.sandbox.docker.binds`を置き換えます。
- 省略された場合、ブラウザコンテナは`agents.defaults.sandbox.docker.binds`にフォールバックします（後方互換）。

例（読み取り専用ソース + 追加データディレクトリ）：

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

セキュリティに関する注意：

- バインドはサンドボックスファイルシステムをバイパスします：設定したモード（`:ro`または`:rw`）でホストパスを公開します。
- OpenClawは危険なバインドソースをブロックします（例：`docker.sock`、`/etc`、`/proc`、`/sys`、`/dev`、およびそれらを公開する親マウント）。
- 機密マウント（シークレット、SSH鍵、サービス認証情報）は絶対に必要でない限り`:ro`にすべきです。
- ワークスペースへの読み取りアクセスのみが必要な場合は`workspaceAccess: "ro"`と組み合わせてください。バインドモードは独立したままです。
- バインドがツールポリシーやelevated execとどのように相互作用するかについては、[サンドボックス vs ツールポリシー vs Elevated](/gateway/sandbox-vs-tool-policy-vs-elevated)を参照してください。

## イメージ + セットアップ

デフォルトイメージ：`openclaw-sandbox:bookworm-slim`

一度ビルドします：

```bash
scripts/sandbox-setup.sh
```

注意：デフォルトイメージにはNodeが**含まれていません**。スキルにNode（またはその他のランタイム）が必要な場合、カスタムイメージをベイクするか、`sandbox.docker.setupCommand`経由でインストールします（ネットワークエグレス + 書き込み可能なルート + rootユーザーが必要）。

サンドボックスブラウザイメージ：

```bash
scripts/sandbox-browser-setup.sh
```

デフォルトでは、サンドボックスコンテナは**ネットワークなし**で実行されます。
`agents.defaults.sandbox.docker.network`でオーバーライドできます。

セキュリティデフォルト：

- `network: "host"`はブロックされます。
- `network: "container:<id>"`はデフォルトでブロックされます（ネームスペース結合バイパスのリスク）。
- ブレイクグラスオーバーライド：`agents.defaults.sandbox.docker.dangerouslyAllowContainerNamespaceJoin: true`。

Dockerインストールとコンテナ化されたGatewayについてはこちら：
[Docker](/install/docker)

## setupCommand（一回限りのコンテナセットアップ）

`setupCommand`はサンドボックスコンテナが作成された**後に1回だけ**実行されます（毎回の実行ではありません）。
`sh -lc`経由でコンテナ内で実行されます。

パス：

- グローバル：`agents.defaults.sandbox.docker.setupCommand`
- エージェントごと：`agents.list[].sandbox.docker.setupCommand`

よくある落とし穴：

- デフォルトの`docker.network`は`"none"`（エグレスなし）なので、パッケージインストールは失敗します。
- `docker.network: "container:<id>"`は`dangerouslyAllowContainerNamespaceJoin: true`が必要で、ブレイクグラスのみです。
- `readOnlyRoot: true`は書き込みを防止します。`readOnlyRoot: false`に設定するか、カスタムイメージをベイクしてください。
- パッケージインストールには`user`がrootである必要があります（`user`を省略するか`user: "0:0"`に設定）。
- サンドボックスexecはホストの`process.env`を継承**しません**。スキルAPIキーには`agents.defaults.sandbox.docker.env`（またはカスタムイメージ）を使用してください。

## ツールポリシー + エスケープハッチ

ツールの許可/拒否ポリシーはサンドボックスルールの前に適用されます。ツールがグローバルまたはエージェントごとに拒否されている場合、サンドボックスはそれを復活させません。

`tools.elevated`はホスト上で`exec`を実行する明示的なエスケープハッチです。
`/exec`ディレクティブは認可された送信者にのみ適用され、セッションごとに永続化されます。`exec`をハード無効化するには、ツールポリシーのdenyを使用してください（[サンドボックス vs ツールポリシー vs Elevated](/gateway/sandbox-vs-tool-policy-vs-elevated)を参照）。

デバッグ：

- `openclaw sandbox explain`を使用して、実効サンドボックスモード、ツールポリシー、修正設定キーを検査します。
- 「なぜこれがブロックされているのか？」のメンタルモデルについては、[サンドボックス vs ツールポリシー vs Elevated](/gateway/sandbox-vs-tool-policy-vs-elevated)を参照してください。
  ロックダウンを維持してください。

## マルチエージェントオーバーライド

各エージェントはサンドボックス + ツールをオーバーライドできます：
`agents.list[].sandbox`と`agents.list[].tools`（およびサンドボックスツールポリシー用の`agents.list[].tools.sandbox.tools`）。
優先順位については[マルチエージェントサンドボックス & ツール](/tools/multi-agent-sandbox-tools)を参照してください。

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

- [サンドボックス設定](/gateway/configuration#agentsdefaults-sandbox)
- [マルチエージェントサンドボックス & ツール](/tools/multi-agent-sandbox-tools)
- [セキュリティ](/gateway/security)
