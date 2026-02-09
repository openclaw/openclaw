---
summary: "OpenClaw のサンドボックス化の仕組み（モード、スコープ、ワークスペースアクセス、イメージ）"
title: サンドボックス化
read_when: "サンドボックス化の専用説明が必要な場合、または agents.defaults.sandbox を調整する必要がある場合。"
status: active
---

# サンドボックス化

OpenClawは**ツールをDockerコンテナ内で実行し、ブラスト半径を減らすことができます。
これは**任意\*\* で、設定によって制御されます (`agents.defaults.sandbox` または
`agents.list[].sandbox` )。 サンドボックス化がオフの場合、ツールはホスト上で実行されます。
ゲートウェイはホスト上にとどまり、ツールの実行は分離されたサンドボックス
で実行されます。

これは完全なセキュリティ境界ではありませんが、モデルが不適切な挙動をした場合でも、ファイルシステムおよびプロセスへのアクセスを実質的に制限します。

## 何がサンドボックス化されるか

- ツール実行（`exec`, `read`, `write`, `edit`, `apply_patch`, `process` など）。
- オプションのサンドボックス化されたブラウザ（`agents.defaults.sandbox.browser`）。
  - デフォルトでは、ブラウザツールがそれを必要とするとき、サンドボックスブラウザの自動起動(CDPが到達可能であることを保証します。
    既定では、ブラウザツールが必要とする際に、サンドボックスブラウザが自動起動（CDP に到達可能であることを保証）します。
    `agents.defaults.sandbox.browser.autoStart` および `agents.defaults.sandbox.browser.autoStartTimeoutMs` で設定します。
  - `agents.defaults.sandbox.browser.allowHostControl` により、サンドボックス化されたセッションがホストブラウザを明示的に対象にできます。
  - オプションの許可リストにより `target: "custom"` を制御します：`allowedControlUrls`, `allowedControlHosts`, `allowedControlPorts`。

サンドボックス化されないもの：

- Gateway プロセス自体。
- 明示的にホスト上での実行が許可されたツール（例：`tools.elevated`）。
  - **昇格実行はホスト上で実行され、サンドボックス化をバイパスします。**
  - サンドボックス化がオフの場合、`tools.elevated` は実行に影響しません（既にホスト上で実行）。[Elevated Mode](/tools/elevated) を参照してください。 [Elevated Mode](/tools/elevated) も参照してください。

## モード

`agents.defaults.sandbox.mode` は、**いつ** サンドボックス化を使用するかを制御します：

- `"off"`：サンドボックス化なし。
- `"non-main"`：**メイン以外** のセッションのみサンドボックス化（ホスト上で通常のチャットを行いたい場合の既定）。
- `"all"`: すべてのセッションは Sandbox 内で実行されます。
  `"all"`：すべてのセッションをサンドボックス内で実行。
  注記：`"non-main"` はエージェント ID ではなく `session.mainKey`（既定は `"main"`）に基づきます。
  グループ／チャンネルセッションは独自のキーを使用するため、非メインとして扱われ、サンドボックス化されます。
  グループ/チャネルセッションでは独自のキーが使用されるため、メイン以外のキーとしてカウントされ、サンドボックス化されます。

## スコープ

`agents.defaults.sandbox.scope` は、**作成されるコンテナ数** を制御します：

- `"session"`（既定）：セッションごとに 1 コンテナ。
- `"agent"`：エージェントごとに 1 コンテナ。
- `"shared"`：すべてのサンドボックス化セッションで 1 コンテナを共有。

## ワークスペースアクセス

`agents.defaults.sandbox.workspaceAccess` は、**サンドボックスが何を参照できるか** を制御します：

- `"none"`（既定）：ツールは `~/.openclaw/sandboxes` 配下のサンドボックスワークスペースを参照します。
- `"ro"`：エージェントワークスペースを読み取り専用で `/agent` にマウントします（`write`/`edit`/`apply_patch` を無効化）。
- `"rw"`：エージェントワークスペースを読み書き可能で `/workspace` にマウントします。

インバウンドメディアはアクティブな Sandbox ワークスペースにコピーされます (`media/inbound/*`)。
スキルノート：`read`ツールはサンドボックスルートです。 受信メディアは、アクティブなサンドボックスワークスペース（`media/inbound/*`）にコピーされます。
Skills に関する注記：`read` ツールはサンドボックスルートです。`workspaceAccess: "none"` を使用すると、
OpenClaw は対象となる Skills をサンドボックスワークスペース（`.../skills`）にミラーし、
読み取り可能にします。`"rw"` を使用すると、ワークスペース Skills は
`/workspace/skills` から読み取り可能になります。 `"rw"`では、ワークスペースのスキルは
`/workspace/skills`から読み取れます。

## カスタム bind マウント

`agents.defaults.sandbox.docker.binds` は、追加のホストディレクトリをコンテナにマウントします。
形式：`host:container:mode`（例：`"/home/user/source:/source:rw"`）。
フォーマット: `host:container:mode` (例: `"/home/user/source:/source:rw"`)。

グローバルおよびエージェント単位の bind は **マージ** されます（置き換えではありません）。
`scope: "shared"` 配下では、エージェント単位の bind は無視されます。 `scope: "shared"`の下では、エージェントごとのバインドは無視されます。

例（読み取り専用ソース + Docker ソケット）：

```json5
{
  agents: {
    defaults: {
      sandbox: {
        docker: {
          binds: ["/home/user/source:/source:ro", "/var/run/docker.sock:/var/run/docker.sock"],
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

セキュリティに関する注記：

- bind はサンドボックスのファイルシステムをバイパスし、設定したモード（`:ro` または `:rw`）でホストパスを公開します。
- 機密性の高いマウント（例：`docker.sock`、シークレット、SSH キー）は、絶対に必要でない限り `:ro` にすべきです。
- ワークスペースへの読み取り専用アクセスのみが必要な場合は `workspaceAccess: "ro"` と併用してください。bind のモードは独立して維持されます。
- bind がツールポリシーおよび昇格実行とどのように相互作用するかについては、[Sandbox vs Tool Policy vs Elevated](/gateway/sandbox-vs-tool-policy-vs-elevated) を参照してください。

## イメージ + セットアップ

既定のイメージ：`openclaw-sandbox:bookworm-slim`

一度だけビルドします：

```bash
scripts/sandbox-setup.sh
```

注意: デフォルトの画像にはNodeは含まれていません。 注記：既定のイメージには Node は **含まれていません**。
Skill が Node（または他のランタイム）を必要とする場合は、カスタムイメージを作成するか、
`sandbox.docker.setupCommand` でインストールしてください（ネットワーク egress + 書き込み可能な root +
root ユーザーが必要）。

サンドボックス化されたブラウザ用イメージ：

```bash
scripts/sandbox-browser-setup.sh
```

既定では、サンドボックスコンテナは **ネットワークなし** で実行されます。
`agents.defaults.sandbox.docker.network` で上書きできます。
`agents.defaults.sandbox.docker.network` で上書きします。

Docker のインストールおよびコンテナ化された Gateway はこちらにあります：
[Docker](/install/docker)

## setupCommand（コンテナ作成時の一回限りのセットアップ）

`setupCommand` は、サンドボックスコンテナ作成後に **一度だけ** 実行されます（毎回の実行ではありません）。
`sh -lc` を介して、コンテナ内で実行されます。
コンテナ内で`sh -lc`を実行します。

パス：

- グローバル：`agents.defaults.sandbox.docker.setupCommand`
- エージェント単位：`agents.list[].sandbox.docker.setupCommand`

よくある落とし穴：

- 既定の `docker.network` は `"none"`（egress なし）であるため、パッケージのインストールは失敗します。
- `readOnlyRoot: true` は書き込みを防止します。`readOnlyRoot: false` を設定するか、カスタムイメージを作成してください。
- パッケージのインストールには `user` が root である必要があります（`user` を省略するか、`user: "0:0"` を設定）。
- サンドボックス実行は、ホストの `process.env` を **継承しません**。
  Skill の API キーには `agents.defaults.sandbox.docker.env`（またはカスタムイメージ）を使用してください。 スキルAPIキーには、
  `agents.defaults.sandbox.docker.env` (またはカスタムイメージ) を使用します。

## ツールポリシー + エスケープハッチ

ツールは Sandbox ルールの前にポリシーを適用します。 ツールの許可／拒否ポリシーは、サンドボックスルールの前に引き続き適用されます。
ツールがグローバルまたはエージェント単位で拒否されている場合、サンドボックス化によって復活することはありません。

`tools.elevated`はホスト上で`exec`を実行する明示的なエスケープハッチです。
`tools.elevated` は、`exec` をホスト上で実行する明示的なエスケープハッチです。
`/exec` ディレクティブは、許可された送信者に対してのみ適用され、セッション単位で保持されます。
`exec` を完全に無効化するには、ツールポリシーの拒否を使用してください
（[Sandbox vs Tool Policy vs Elevated](/gateway/sandbox-vs-tool-policy-vs-elevated) を参照）。

デバッグ：

- `openclaw sandbox explain` を使用して、有効なサンドボックスモード、ツールポリシー、修正用設定キーを確認します。
- 「なぜブロックされているのか？」という理解モデルについては、[Sandbox vs Tool Policy vs Elevated](/gateway/sandbox-vs-tool-policy-vs-elevated) を参照してください。
  厳格にロックダウンしてください。
  鍵をかけたままにしておきなさい。

## マルチエージェントの上書き

各エージェントは、サンドボックスおよびツールを上書きできます：
`agents.list[].sandbox` および `agents.list[].tools`（サンドボックスのツールポリシーには `agents.list[].tools.sandbox.tools` も使用）。
優先順位については、[Multi-Agent Sandbox & Tools](/tools/multi-agent-sandbox-tools) を参照してください。
優先度については、[Multi-Agent Sandbox & Tools](/tools/multi-agent-sandbox-tools)を参照してください。

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

- [Sandbox Configuration](/gateway/configuration#agentsdefaults-sandbox)
- [Multi-Agent Sandbox & Tools](/tools/multi-agent-sandbox-tools)
- [Security](/gateway/security)
