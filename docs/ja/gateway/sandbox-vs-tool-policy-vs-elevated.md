---
title: サンドボックス vs ツールポリシー vs 昇格
summary: "ツールがブロックされる理由：サンドボックスのランタイム、ツールの許可／拒否ポリシー、昇格実行ゲート"
read_when: "「サンドボックスの牢屋」に入った、またはツール／昇格の拒否を見て、変更すべき正確な設定キーを知りたいとき。"
status: active
---

# サンドボックス vs ツールポリシー vs 昇格

OpenClaw には、関連はしているものの異なる 3 つの制御があります。

1. **サンドボックス**（`agents.defaults.sandbox.*` / `agents.list[].sandbox.*`）は、**ツールをどこで実行するか**（Docker vs ホスト）を決定します。
2. **ツールポリシー**（`tools.*`, `tools.sandbox.tools.*`, `agents.list[].tools.*`）は、**どのツールが利用可能／許可されるか**を決定します。
3. **昇格**（`tools.elevated.*`, `agents.list[].tools.elevated.*`）は、サンドボックス化されている場合にホストで実行するための**exec 専用のエスケープハッチ**です。

## クイックデバッグ

インスペクターを使用して、OpenClaw が _実際に_ 何をしているかを確認します。

```bash
openclaw sandbox explain
openclaw sandbox explain --session agent:main:main
openclaw sandbox explain --agent work
openclaw sandbox explain --json
```

印刷します。

- 有効なサンドボックスのモード／スコープ／ワークスペースアクセス
- セッションが現在サンドボックス化されているか（メイン vs 非メイン）
- 有効なサンドボックスのツール許可／拒否（エージェント／グローバル／デフォルトのどれ由来か）
- 昇格ゲートと修正用キーのパス

## サンドボックス：ツールを実行する場所

サンドボックス化は `agents.defaults.sandbox.mode` により制御されます。

- `"off"`：すべてがホスト上で実行されます。
- `"non-main"`：非メインのセッションのみがサンドボックス化されます（グループ／チャンネルでの一般的な「想定外」）。
- `"all"`：すべてがサンドボックス化されます。

完全なマトリクス（スコープ、ワークスペースのマウント、イメージ）については、[Sandboxing](/gateway/sandboxing) を参照してください。

### バインドマウント（セキュリティのクイックチェック）

- `docker.binds` はサンドボックスのファイルシステムを _貫通_ します。マウントしたものは、設定したモード（`:ro` または `:rw`）でコンテナ内から可視になります。
- モードを省略した場合のデフォルトは読み書き可能です。ソース／シークレットには `:ro` を推奨します。
- `scope: "shared"` はエージェントごとのバインドを無視します（グローバルバインドのみが適用されます）。
- `/var/run/docker.sock` をバインドすると、事実上ホストの制御をサンドボックスに渡すことになります。意図した場合にのみ行ってください。
- ワークスペースアクセス（`workspaceAccess: "ro"`/`"rw"`）は、バインドのモードとは独立しています。

## ツールポリシー：どのツールが存在／呼び出し可能か

二つの層が重要です:

- **ツールプロファイル**：`tools.profile` と `agents.list[].tools.profile`（ベースの許可リスト）
- **プロバイダーツールプロファイル**：`tools.byProvider[provider].profile` と `agents.list[].tools.byProvider[provider].profile`
- **グローバル／エージェント別ツールポリシー**：`tools.allow`/`tools.deny` と `agents.list[].tools.allow`/`agents.list[].tools.deny`
- **プロバイダーツールポリシー**：`tools.byProvider[provider].allow/deny` と `agents.list[].tools.byProvider[provider].allow/deny`
- **サンドボックスのツールポリシー**（サンドボックス化時のみ適用）：`tools.sandbox.tools.allow`/`tools.sandbox.tools.deny` と `agents.list[].tools.sandbox.tools.*`

親指のルール:

- `deny` が常に優先されます。
- `allow` が空でない場合、他はすべてブロックとして扱われます。
- ツールポリシーはハードストップです。`/exec` は、拒否された `exec` のツールを上書きできません。
- `/exec` は、許可された送信者のセッション既定値を変更するだけで、ツールアクセスを付与しません。  
  プロバイダーツールのキーは、`provider`（例：`google-antigravity`）または `provider/model`（例：`openai/gpt-5.2`）のいずれかを受け付けます。
  プロバイダのツールキーは、`provider`（例：`google-antigubity`）または`provider/model`（例：`openai/gpt-5.2`）のいずれかを受け付けます。

### ツールグループ（省略表記）

ツールポリシー（グローバル、エージェント、サンドボックス）は、複数のツールに展開される `group:*` エントリをサポートします。

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

- `group:runtime`：`exec`, `bash`, `process`
- `group:fs`：`read`, `write`, `edit`, `apply_patch`
- `group:sessions`：`sessions_list`, `sessions_history`, `sessions_send`, `sessions_spawn`, `session_status`
- `group:memory`：`memory_search`, `memory_get`
- `group:ui`：`browser`, `canvas`
- `group:automation`：`cron`, `gateway`
- `group:messaging`：`message`
- `group:nodes`：`nodes`
- `group:openclaw`：すべての組み込み OpenClaw ツール（プロバイダープラグインは除外）

## 昇格：exec 専用の「ホストで実行」

昇格は**追加のツールを付与しません**。影響するのは `exec` のみです。

- サンドボックス化されている場合、`/elevated on`（または `exec` と `elevated: true`）はホストで実行されます（承認が必要な場合があります）。
- セッションの exec 承認をスキップするには `/elevated full` を使用します。
- すでに直接実行している場合、昇格は実質的にノーオペレーションです（引き続きゲートされます）。
- 昇格は **スキルスコープ** ではなく、ツールの allow/deny を **上書きしません** 。
- `/exec`は上昇したものとは別です。 これは、承認された送信者のセッションごとの執行のデフォルトのみを調整します。

ゲート：

- 有効化：`tools.elevated.enabled`（必要に応じて `agents.list[].tools.elevated.enabled`）
- 送信者の許可リスト：`tools.elevated.allowFrom.<provider>`（必要に応じて `agents.list[].tools.elevated.allowFrom.<provider>`）

[Elevated Mode](/tools/elevated) も参照してください。

## 一般的な「サンドボックスの牢屋」の修正

### 「ツール X がサンドボックスのツールポリシーでブロックされる」

修正キー（いずれかを選択）：

- サンドボックスを無効化：`agents.defaults.sandbox.mode=off`（またはエージェント別に `agents.list[].sandbox.mode=off`）
- サンドボックス内でツールを許可：
  - `tools.sandbox.tools.deny`（またはエージェント別の `agents.list[].tools.sandbox.tools.deny`）から削除
  - または `tools.sandbox.tools.allow`（またはエージェント別の許可）に追加

### 「これはメインだと思っていたのに、なぜサンドボックス化されている？」

`"non-main"` モードでは、グループ／チャンネルのキーはメインではありません。`sandbox explain` で表示されるメインセッションのキーを使用するか、モードを `"off"` に切り替えてください。 メインセッションキー（`sandbox explan` で表示）を使用するか、モードを`"off"`に切り替えます。
