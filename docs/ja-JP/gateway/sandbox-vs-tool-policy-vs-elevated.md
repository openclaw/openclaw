---
title: サンドボックス vs ツールポリシー vs Elevated
summary: "ツールがブロックされる理由：サンドボックスランタイム、ツール許可/拒否ポリシー、Elevated execゲート"
read_when: "You hit 'sandbox jail' or see a tool/elevated refusal and want the exact config key to change."
status: active
---

# サンドボックス vs ツールポリシー vs Elevated

OpenClawには3つの関連する（ただし異なる）コントロールがあります：

1. **サンドボックス**（`agents.defaults.sandbox.*` / `agents.list[].sandbox.*`）は**ツールがどこで実行されるか**（Docker vs ホスト）を決定します。
2. **ツールポリシー**（`tools.*`、`tools.sandbox.tools.*`、`agents.list[].tools.*`）は**どのツールが利用可能/許可されるか**を決定します。
3. **Elevated**（`tools.elevated.*`、`agents.list[].tools.elevated.*`）は、サンドボックス中にホスト上で実行するための**exec専用のエスケープハッチ**です。

## クイックデバッグ

インスペクターを使用してOpenClawが_実際に_何をしているかを確認します：

```bash
openclaw sandbox explain
openclaw sandbox explain --session agent:main:main
openclaw sandbox explain --agent work
openclaw sandbox explain --json
```

以下が出力されます：

- 実効サンドボックスモード/スコープ/ワークスペースアクセス
- セッションが現在サンドボックス化されているかどうか（mainか非mainか）
- 実効サンドボックスツールの許可/拒否（エージェント/グローバル/デフォルトのどこから来たか）
- Elevatedゲートと修正キーパス

## サンドボックス：ツールがどこで実行されるか

サンドボックスは`agents.defaults.sandbox.mode`で制御されます：

- `"off"`：すべてがホスト上で実行されます。
- `"non-main"`：非mainセッションのみがサンドボックス化されます（グループ/チャンネルでよくある「予想外」のケース）。
- `"all"`：すべてがサンドボックス化されます。

完全なマトリックス（スコープ、ワークスペースマウント、イメージ）については[サンドボックス](/gateway/sandboxing)を参照してください。

### バインドマウント（セキュリティクイックチェック）

- `docker.binds`はサンドボックスファイルシステムを_貫通_します：マウントしたものは設定したモード（`:ro`または`:rw`）でコンテナ内から見えます。
- モードを省略した場合のデフォルトは読み書き可能です。ソース/シークレットには`:ro`を推奨します。
- `scope: "shared"`はエージェントごとのバインドを無視します（グローバルバインドのみ適用）。
- `/var/run/docker.sock`をバインドすると、事実上ホストの制御をサンドボックスに委ねます。意図的に行ってください。
- ワークスペースアクセス（`workspaceAccess: "ro"`/`"rw"`）はバインドモードとは独立しています。

## ツールポリシー：どのツールが存在/呼び出し可能か

2つのレイヤーが重要です：

- **ツールプロファイル**：`tools.profile`と`agents.list[].tools.profile`（ベースの許可リスト）
- **プロバイダーツールプロファイル**：`tools.byProvider[provider].profile`と`agents.list[].tools.byProvider[provider].profile`
- **グローバル/エージェントごとのツールポリシー**：`tools.allow`/`tools.deny`と`agents.list[].tools.allow`/`agents.list[].tools.deny`
- **プロバイダーツールポリシー**：`tools.byProvider[provider].allow/deny`と`agents.list[].tools.byProvider[provider].allow/deny`
- **サンドボックスツールポリシー**（サンドボックス化されている場合のみ適用）：`tools.sandbox.tools.allow`/`tools.sandbox.tools.deny`と`agents.list[].tools.sandbox.tools.*`

経験則：

- `deny`が常に優先されます。
- `allow`が空でない場合、それ以外はすべてブロックとして扱われます。
- ツールポリシーはハードストップです：`/exec`は拒否された`exec`ツールをオーバーライドできません。
- `/exec`は認可された送信者のセッションデフォルトのみを変更します。ツールアクセスを付与しません。
  プロバイダーツールキーは`provider`（例：`google-antigravity`）または`provider/model`（例：`openai/gpt-5.2`）のいずれかを受け入れます。

### ツールグループ（ショートハンド）

ツールポリシー（グローバル、エージェント、サンドボックス）は複数のツールに展開される`group:*`エントリをサポートします：

```json5
{
  tools: {
    sandbox: {
      tools: {
        allow: ["group:runtime", "group:fs", "group:sessions", "group:memory"],
      },
    },
  },
}
```

利用可能なグループ：

- `group:runtime`：`exec`、`bash`、`process`
- `group:fs`：`read`、`write`、`edit`、`apply_patch`
- `group:sessions`：`sessions_list`、`sessions_history`、`sessions_send`、`sessions_spawn`、`session_status`
- `group:memory`：`memory_search`、`memory_get`
- `group:ui`：`browser`、`canvas`
- `group:automation`：`cron`、`gateway`
- `group:messaging`：`message`
- `group:nodes`：`nodes`
- `group:openclaw`：すべての組み込みOpenClawツール（プロバイダープラグインを除く）

## Elevated：exec専用の「ホスト上で実行」

Elevatedは追加のツールを付与**しません**。`exec`にのみ影響します。

- サンドボックス化されている場合、`/elevated on`（または`elevated: true`付きの`exec`）はホスト上で実行します（承認がまだ適用される場合があります）。
- `/elevated full`を使用するとセッションのexec承認をスキップします。
- すでに直接実行している場合、elevatedは事実上ノーオペレーションです（ゲートされますが）。
- Elevatedはスキルスコープ**ではなく**、ツールの許可/拒否をオーバーライド**しません**。
- `/exec`はelevatedとは別です。認可された送信者のセッションごとのexecデフォルトのみを調整します。

ゲート：

- 有効化：`tools.elevated.enabled`（およびオプションで`agents.list[].tools.elevated.enabled`）
- 送信者許可リスト：`tools.elevated.allowFrom.<provider>`（およびオプションで`agents.list[].tools.elevated.allowFrom.<provider>`）

[Elevatedモード](/tools/elevated)を参照してください。

## 一般的な「サンドボックスジェイル」の修正

### 「ツールXはサンドボックスツールポリシーによってブロックされました」

修正キー（いずれかを選択）：

- サンドボックスを無効化：`agents.defaults.sandbox.mode=off`（またはエージェントごとの`agents.list[].sandbox.mode=off`）
- サンドボックス内でツールを許可：
  - `tools.sandbox.tools.deny`から削除（またはエージェントごとの`agents.list[].tools.sandbox.tools.deny`）
  - または`tools.sandbox.tools.allow`に追加（またはエージェントごとのallow）

### 「mainだと思っていたのに、なぜサンドボックス化されているのか？」

`"non-main"`モードでは、グループ/チャンネルキーはmainでは_ありません_。メインセッションキー（`sandbox explain`で表示）を使用するか、モードを`"off"`に切り替えてください。
