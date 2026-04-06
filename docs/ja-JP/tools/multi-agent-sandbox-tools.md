---
read_when: “You want per-agent sandboxing or per-agent tool allow/deny policies in a multi-agent gateway.”
status: active
summary: エージェントごとのサンドボックス + ツール制限、優先順位、および設定例
title: マルチエージェント サンドボックス & ツール
x-i18n:
    generated_at: "2026-04-02T07:56:31Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: 9a21e88c46101f5f8ba4dfb111c92b216e5d7784870aef548940ca8b01aa20ad
    source_path: tools/multi-agent-sandbox-tools.md
    workflow: 15
---

# マルチエージェント サンドボックス & ツール設定

マルチエージェント構成の各エージェントは、グローバルなサンドボックスおよびツール
ポリシーをオーバーライドできます。このページでは、エージェントごとの設定、優先順位ルール、
および設定例を説明します。

- **サンドボックスのバックエンドとモード**：[サンドボックス化](/gateway/sandboxing) を参照してください。
- **ブロックされたツールのデバッグ**：[サンドボックス vs ツールポリシー vs 昇格モード](/gateway/sandbox-vs-tool-policy-vs-elevated) および `openclaw sandbox explain` を参照してください。
- **昇格実行**：[昇格モード](/tools/elevated) を参照してください。

認証はエージェントごとに管理されます。各エージェントは自身の `agentDir` 認証ストア
`~/.openclaw/agents/<agentId>/agent/auth-profiles.json` から読み取ります。
認証情報はエージェント間で**共有されません**。`agentDir` を複数のエージェントで再利用しないでください。
認証情報を共有したい場合は、`auth-profiles.json` を他のエージェントの `agentDir` にコピーしてください。

---

## 設定例

### 例 1：個人用 + 制限付きファミリーエージェント

```json
{
  "agents": {
    "list": [
      {
        "id": "main",
        "default": true,
        "name": "Personal Assistant",
        "workspace": "~/.openclaw/workspace",
        "sandbox": { "mode": "off" }
      },
      {
        "id": "family",
        "name": "Family Bot",
        "workspace": "~/.openclaw/workspace-family",
        "sandbox": {
          "mode": "all",
          "scope": "agent"
        },
        "tools": {
          "allow": ["read"],
          "deny": ["exec", "write", "edit", "apply_patch", "process", "browser"]
        }
      }
    ]
  },
  "bindings": [
    {
      "agentId": "family",
      "match": {
        "provider": "whatsapp",
        "accountId": "*",
        "peer": {
          "kind": "group",
          "id": "120363424282127706@g.us"
        }
      }
    }
  ]
}
```

**結果：**

- `main` エージェント：ホスト上で実行、すべてのツールにアクセス可能
- `family` エージェント：Docker で実行（エージェントごとに1コンテナ）、`read` ツールのみ

---

### 例 2：共有サンドボックス付きワークエージェント

```json
{
  "agents": {
    "list": [
      {
        "id": "personal",
        "workspace": "~/.openclaw/workspace-personal",
        "sandbox": { "mode": "off" }
      },
      {
        "id": "work",
        "workspace": "~/.openclaw/workspace-work",
        "sandbox": {
          "mode": "all",
          "scope": "shared",
          "workspaceRoot": "/tmp/work-sandboxes"
        },
        "tools": {
          "allow": ["read", "write", "apply_patch", "exec"],
          "deny": ["browser", "gateway", "discord"]
        }
      }
    ]
  }
}
```

---

### 例 2b：グローバルコーディングプロファイル + メッセージング専用エージェント

```json
{
  "tools": { "profile": "coding" },
  "agents": {
    "list": [
      {
        "id": "support",
        "tools": { "profile": "messaging", "allow": ["slack"] }
      }
    ]
  }
}
```

**結果：**

- デフォルトのエージェントはコーディングツールを取得
- `support` エージェントはメッセージング専用（+ Slack ツール）

---

### 例 3：エージェントごとに異なるサンドボックスモード

```json
{
  "agents": {
    "defaults": {
      "sandbox": {
        "mode": "non-main", // グローバルデフォルト
        "scope": "session"
      }
    },
    "list": [
      {
        "id": "main",
        "workspace": "~/.openclaw/workspace",
        "sandbox": {
          "mode": "off" // オーバーライド：main はサンドボックス化しない
        }
      },
      {
        "id": "public",
        "workspace": "~/.openclaw/workspace-public",
        "sandbox": {
          "mode": "all", // オーバーライド：public は常にサンドボックス化
          "scope": "agent"
        },
        "tools": {
          "allow": ["read"],
          "deny": ["exec", "write", "edit", "apply_patch"]
        }
      }
    ]
  }
}
```

---

## 設定の優先順位

グローバル（`agents.defaults.*`）とエージェント固有（`agents.list[].*`）の両方の設定が存在する場合：

### サンドボックス設定

エージェント固有の設定がグローバルをオーバーライドします：

```
agents.list[].sandbox.mode > agents.defaults.sandbox.mode
agents.list[].sandbox.scope > agents.defaults.sandbox.scope
agents.list[].sandbox.workspaceRoot > agents.defaults.sandbox.workspaceRoot
agents.list[].sandbox.workspaceAccess > agents.defaults.sandbox.workspaceAccess
agents.list[].sandbox.docker.* > agents.defaults.sandbox.docker.*
agents.list[].sandbox.browser.* > agents.defaults.sandbox.browser.*
agents.list[].sandbox.prune.* > agents.defaults.sandbox.prune.*
```

**注意事項：**

- `agents.list[].sandbox.{docker,browser,prune}.*` は、そのエージェントに対して `agents.defaults.sandbox.{docker,browser,prune}.*` をオーバーライドします（サンドボックススコープが `"shared"` に解決される場合は無視されます）。

### ツール制限

フィルタリング順序は以下の通りです：

1. **ツールプロファイル**（`tools.profile` または `agents.list[].tools.profile`）
2. **プロバイダーツールプロファイル**（`tools.byProvider[provider].profile` または `agents.list[].tools.byProvider[provider].profile`）
3. **グローバルツールポリシー**（`tools.allow` / `tools.deny`）
4. **プロバイダーツールポリシー**（`tools.byProvider[provider].allow/deny`）
5. **エージェント固有のツールポリシー**（`agents.list[].tools.allow/deny`）
6. **エージェントプロバイダーポリシー**（`agents.list[].tools.byProvider[provider].allow/deny`）
7. **サンドボックスツールポリシー**（`tools.sandbox.tools` または `agents.list[].tools.sandbox.tools`）
8. **サブエージェントツールポリシー**（`tools.subagents.tools`、該当する場合）

各レベルはツールをさらに制限できますが、前のレベルで拒否されたツールを復元することはできません。
`agents.list[].tools.sandbox.tools` が設定されている場合、そのエージェントでは `tools.sandbox.tools` を置き換えます。
`agents.list[].tools.profile` が設定されている場合、そのエージェントでは `tools.profile` をオーバーライドします。
プロバイダーツールキーは `provider`（例：`google-antigravity`）または `provider/model`（例：`openai/gpt-5.2`）のいずれかを受け付けます。

ツールポリシーは複数のツールに展開される `group:*` ショートハンドをサポートしています。完全なリストは[ツールグループ](/gateway/sandbox-vs-tool-policy-vs-elevated#tool-groups-shorthands)を参照してください。

エージェントごとの昇格オーバーライド（`agents.list[].tools.elevated`）により、特定のエージェントの昇格実行をさらに制限できます。詳細は[昇格モード](/tools/elevated)を参照してください。

---

## シングルエージェントからの移行

**移行前（シングルエージェント）：**

```json
{
  "agents": {
    "defaults": {
      "workspace": "~/.openclaw/workspace",
      "sandbox": {
        "mode": "non-main"
      }
    }
  },
  "tools": {
    "sandbox": {
      "tools": {
        "allow": ["read", "write", "apply_patch", "exec"],
        "deny": []
      }
    }
  }
}
```

**移行後（異なるプロファイルのマルチエージェント）：**

```json
{
  "agents": {
    "list": [
      {
        "id": "main",
        "default": true,
        "workspace": "~/.openclaw/workspace",
        "sandbox": { "mode": "off" }
      }
    ]
  }
}
```

レガシーの `agent.*` 設定は `openclaw doctor` によって移行されます。今後は `agents.defaults` + `agents.list` の使用を推奨します。

---

## ツール制限の例

### 読み取り専用エージェント

```json
{
  "tools": {
    "allow": ["read"],
    "deny": ["exec", "write", "edit", "apply_patch", "process"]
  }
}
```

### 安全な実行エージェント（ファイル変更なし）

```json
{
  "tools": {
    "allow": ["read", "exec", "process"],
    "deny": ["write", "edit", "apply_patch", "browser", "gateway"]
  }
}
```

### コミュニケーション専用エージェント

```json
{
  "tools": {
    "sessions": { "visibility": "tree" },
    "allow": ["sessions_list", "sessions_send", "sessions_history", "session_status"],
    "deny": ["exec", "write", "edit", "apply_patch", "read", "browser"]
  }
}
```

---

## よくある落とし穴：「non-main」

`agents.defaults.sandbox.mode: "non-main"` は `session.mainKey`（デフォルトは `"main"`）に基づいており、
エージェント ID ではありません。グループ/チャネルのセッションは常に独自のキーを取得するため、
non-main として扱われ、サンドボックス化されます。エージェントを絶対にサンドボックス化したくない場合は、
`agents.list[].sandbox.mode: "off"` を設定してください。

---

## テスト

マルチエージェントのサンドボックスとツールを設定した後：

1. **エージェントの解決を確認：**

   ```exec
   openclaw agents list --bindings
   ```

2. **サンドボックスコンテナを確認：**

   ```exec
   docker ps --filter "name=openclaw-sbx-"
   ```

3. **ツール制限をテスト：**
   - 制限されたツールを必要とするメッセージを送信
   - エージェントが拒否されたツールを使用できないことを確認

4. **ログを監視：**

   ```exec
   tail -f "${OPENCLAW_STATE_DIR:-$HOME/.openclaw}/logs/gateway.log" | grep -E "routing|sandbox|tools"
   ```

---

## トラブルシューティング

### `mode: "all"` にもかかわらずエージェントがサンドボックス化されない

- グローバルの `agents.defaults.sandbox.mode` がオーバーライドしていないか確認
- エージェント固有の設定が優先されるため、`agents.list[].sandbox.mode: "all"` を設定してください

### 拒否リストにもかかわらずツールがまだ利用可能

- ツールフィルタリング順序を確認：グローバル → エージェント → サンドボックス → サブエージェント
- 各レベルはさらに制限のみ可能で、復元はできません
- ログで確認：`[tools] filtering tools for agent:${agentId}`

### エージェントごとにコンテナが分離されない

- エージェント固有のサンドボックス設定で `scope: "agent"` を設定してください
- デフォルトは `"session"` で、セッションごとに1つのコンテナが作成されます

---

## 関連項目

- [サンドボックス化](/gateway/sandboxing) -- サンドボックスの完全なリファレンス（モード、スコープ、バックエンド、イメージ）
- [サンドボックス vs ツールポリシー vs 昇格モード](/gateway/sandbox-vs-tool-policy-vs-elevated) -- 「なぜブロックされているのか？」のデバッグ
- [昇格モード](/tools/elevated)
- [マルチエージェントルーティング](/concepts/multi-agent)
- [サンドボックス設定](/gateway/configuration-reference#agentsdefaultssandbox)
- [セッション管理](/concepts/session)
