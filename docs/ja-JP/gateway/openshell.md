---
read_when:
    - ローカル Docker の代わりにクラウドマネージドサンドボックスを使用したい場合
    - OpenShell プラグインをセットアップする場合
    - mirror モードと remote ワークスペースモードのどちらを選ぶか決める必要がある場合
summary: OpenShell を OpenClaw エージェントのマネージドサンドボックスバックエンドとして使用する
title: OpenShell
x-i18n:
    generated_at: "2026-04-02T08:32:07Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: aaf9027d0632a70fb86455f8bc46dc908ff766db0eb0cdf2f7df39c715241ead
    source_path: gateway/openshell.md
    workflow: 15
---

# OpenShell

OpenShell は OpenClaw 向けのマネージドサンドボックスバックエンドです。ローカルで Docker
コンテナを実行する代わりに、OpenClaw はサンドボックスのライフサイクルを `openshell` CLI に
委譲し、SSH ベースのコマンド実行によるリモート環境をプロビジョニングします。

OpenShell プラグインは、汎用の [SSH バックエンド](/gateway/sandboxing#ssh-backend)と同じ
コア SSH トランスポートおよびリモートファイルシステムブリッジを再利用します。さらに
OpenShell 固有のライフサイクル（`sandbox create/get/delete`、`sandbox ssh-config`）と
オプションの `mirror` ワークスペースモードが追加されています。

## 前提条件

- `openshell` CLI がインストール済みで `PATH` に含まれていること（または
  `plugins.entries.openshell.config.command` でカスタムパスを設定）
- サンドボックスアクセス権を持つ OpenShell アカウント
- ホスト上で OpenClaw Gateway ゲートウェイが実行中であること

## クイックスタート

1. プラグインを有効にし、サンドボックスバックエンドを設定します:

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
          mode: "remote",
        },
      },
    },
  },
}
```

2. Gateway ゲートウェイを再起動します。次のエージェントターンで、OpenClaw は OpenShell
   サンドボックスを作成し、ツール実行をそこにルーティングします。

3. 確認:

```bash
openclaw sandbox list
openclaw sandbox explain
```

## ワークスペースモード

OpenShell を使用する際に最も重要な決定事項です。

### `mirror`

**ローカルワークスペースを正規のソース**としたい場合は
`plugins.entries.openshell.config.mode: "mirror"` を使用します。

動作:

- `exec` の前に、OpenClaw はローカルワークスペースを OpenShell サンドボックスに同期します。
- `exec` の後に、OpenClaw はリモートワークスペースをローカルワークスペースに同期し直します。
- ファイルツールは引き続きサンドボックスブリッジを通じて動作しますが、ターン間では
  ローカルワークスペースが信頼できるソースのままです。

最適な用途:

- OpenClaw の外部でローカルファイルを編集し、その変更をサンドボックスに自動的に
  反映させたい場合。
- OpenShell サンドボックスを Docker バックエンドにできるだけ近い動作にしたい場合。
- 各 exec ターン後にホストワークスペースにサンドボックスの書き込みを反映させたい場合。

トレードオフ: 各 exec の前後に追加の同期コストが発生します。

### `remote`

**OpenShell ワークスペースを正規のソース**としたい場合は
`plugins.entries.openshell.config.mode: "remote"` を使用します。

動作:

- サンドボックスの初回作成時に、OpenClaw はローカルワークスペースからリモートワークスペースに
  1回だけシードします。
- その後、`exec`、`read`、`write`、`edit`、`apply_patch` はリモートの OpenShell
  ワークスペースに対して直接操作します。
- OpenClaw はリモートの変更をローカルワークスペースに同期し直し**ません**。
- プロンプト時のメディア読み取りは、ファイルおよびメディアツールがサンドボックスブリッジを
  通じて読み取るため、引き続き動作します。

最適な用途:

- サンドボックスを主にリモート側で運用したい場合。
- ターンごとの同期オーバーヘッドを低く抑えたい場合。
- ホストローカルの編集がリモートサンドボックスの状態を暗黙的に上書きしないようにしたい場合。

重要: 初回シード後にホスト上で OpenClaw の外部でファイルを編集しても、リモートサンドボックスに
はその変更が**反映されません**。再シードするには `openclaw sandbox recreate` を使用してください。

### モードの選択

|                              | `mirror`                       | `remote`                            |
| ---------------------------- | ------------------------------ | ----------------------------------- |
| **正規のワークスペース**     | ローカルホスト                 | リモート OpenShell                  |
| **同期方向**                 | 双方向（各 exec ごと）         | 1回限りのシード                     |
| **ターンごとのオーバーヘッド** | 高い（アップロード + ダウンロード） | 低い（直接リモート操作）        |
| **ローカル編集が反映されるか？** | はい、次の exec 時に         | いいえ、recreate するまで           |
| **最適な用途**               | 開発ワークフロー               | 長時間実行エージェント、CI          |

## 設定リファレンス

OpenShell の設定はすべて `plugins.entries.openshell.config` 配下にあります:

| キー                        | 型                       | デフォルト      | 説明                                                  |
| --------------------------- | ------------------------ | --------------- | ----------------------------------------------------- |
| `mode`                      | `"mirror"` or `"remote"` | `"mirror"`     | ワークスペース同期モード                              |
| `command`                   | `string`                 | `"openshell"`  | `openshell` CLI のパスまたは名前                      |
| `from`                      | `string`                 | `"openclaw"`   | 初回作成時のサンドボックスソース                      |
| `gateway`                   | `string`                 | —              | OpenShell ゲートウェイ名（`--gateway`）               |
| `gatewayEndpoint`           | `string`                 | —              | OpenShell ゲートウェイエンドポイント URL（`--gateway-endpoint`） |
| `policy`                    | `string`                 | —              | サンドボックス作成用の OpenShell ポリシー ID          |
| `providers`                 | `string[]`               | `[]`           | サンドボックス作成時にアタッチするプロバイダー名      |
| `gpu`                       | `boolean`                | `false`        | GPU リソースをリクエスト                              |
| `autoProviders`             | `boolean`                | `true`         | サンドボックス作成時に `--auto-providers` を渡す      |
| `remoteWorkspaceDir`        | `string`                 | `"/sandbox"`   | サンドボックス内のプライマリ書き込み可能ワークスペース |
| `remoteAgentWorkspaceDir`   | `string`                 | `"/agent"`     | エージェントワークスペースのマウントパス（読み取り専用アクセス用） |
| `timeoutSeconds`            | `number`                 | `120`          | `openshell` CLI 操作のタイムアウト                    |

サンドボックスレベルの設定（`mode`、`scope`、`workspaceAccess`）は、他のバックエンドと
同様に `agents.defaults.sandbox` 配下で設定します。完全なマトリクスについては
[サンドボックス化](/gateway/sandboxing)を参照してください。

## 使用例

### 最小構成の remote セットアップ

```json5
{
  agents: {
    defaults: {
      sandbox: {
        mode: "all",
        backend: "openshell",
      },
    },
  },
  plugins: {
    entries: {
      openshell: {
        enabled: true,
        config: {
          from: "openclaw",
          mode: "remote",
        },
      },
    },
  },
}
```

### GPU 付き mirror モード

```json5
{
  agents: {
    defaults: {
      sandbox: {
        mode: "all",
        backend: "openshell",
        scope: "agent",
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
          mode: "mirror",
          gpu: true,
          providers: ["openai"],
          timeoutSeconds: 180,
        },
      },
    },
  },
}
```

### カスタムゲートウェイを使用したエージェントごとの OpenShell

```json5
{
  agents: {
    defaults: {
      sandbox: { mode: "off" },
    },
    list: [
      {
        id: "researcher",
        sandbox: {
          mode: "all",
          backend: "openshell",
          scope: "agent",
          workspaceAccess: "rw",
        },
      },
    ],
  },
  plugins: {
    entries: {
      openshell: {
        enabled: true,
        config: {
          from: "openclaw",
          mode: "remote",
          gateway: "lab",
          gatewayEndpoint: "https://lab.example",
          policy: "strict",
        },
      },
    },
  },
}
```

## ライフサイクル管理

OpenShell サンドボックスは通常のサンドボックス CLI を通じて管理されます:

```bash
# すべてのサンドボックスランタイムを一覧表示（Docker + OpenShell）
openclaw sandbox list

# 有効なポリシーを確認
openclaw sandbox explain

# 再作成（リモートワークスペースを削除し、次回使用時に再シード）
openclaw sandbox recreate --all
```

`remote` モードでは、**再作成が特に重要です**: そのスコープの正規のリモートワークスペースが
削除されます。次回使用時にローカルワークスペースから新しいリモートワークスペースがシードされます。

`mirror` モードでは、ローカルワークスペースが正規のソースのままであるため、再作成は主に
リモート実行環境をリセットするだけです。

### 再作成が必要なタイミング

以下のいずれかを変更した後に再作成してください:

- `agents.defaults.sandbox.backend`
- `plugins.entries.openshell.config.from`
- `plugins.entries.openshell.config.mode`
- `plugins.entries.openshell.config.policy`

```bash
openclaw sandbox recreate --all
```

## 現在の制限事項

- サンドボックスブラウザは OpenShell バックエンドではサポートされていません。
- `sandbox.docker.binds` は OpenShell には適用されません。
- `sandbox.docker.*` 配下の Docker 固有のランタイム設定は Docker バックエンドにのみ
  適用されます。

## 仕組み

1. OpenClaw は `openshell sandbox create` を呼び出します（設定に応じて `--from`、`--gateway`、
   `--policy`、`--providers`、`--gpu` フラグを付与）。
2. OpenClaw は `openshell sandbox ssh-config <name>` を呼び出して、サンドボックスの
   SSH 接続詳細を取得します。
3. コアは SSH 設定を一時ファイルに書き込み、汎用 SSH バックエンドと同じリモート
   ファイルシステムブリッジを使用して SSH セッションを開きます。
4. `mirror` モード: exec 前にローカルからリモートに同期し、実行後にリモートからローカルに
   同期し直します。
5. `remote` モード: 作成時に1回だけシードし、その後はリモートワークスペースに対して
   直接操作します。

## 関連項目

- [サンドボックス化](/gateway/sandboxing) -- モード、スコープ、バックエンド比較
- [サンドボックス vs ツールポリシー vs 昇格](/gateway/sandbox-vs-tool-policy-vs-elevated) -- ブロックされたツールのデバッグ
- [マルチエージェントのサンドボックスとツール](/tools/multi-agent-sandbox-tools) -- エージェントごとのオーバーライド
- [サンドボックス CLI](/cli/sandbox) -- `openclaw sandbox` コマンド
