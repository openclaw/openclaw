---
summary: "エージェントごとのサンドボックス化 + ツール制限、優先順位、および例"
title: マルチエージェントのサンドボックス & ツール
read_when: "マルチエージェント ゲートウェイで、エージェントごとのサンドボックス化やツールの許可 / 拒否ポリシーが必要な場合。"
status: active
---

# マルチエージェントのサンドボックス & ツール設定

## 概要

マルチエージェント構成では、各エージェントが次を個別に持てます。

- **サンドボックス設定**（`agents.list[].sandbox` が `agents.defaults.sandbox` を上書き）
- **ツール制限**（`tools.allow` / `tools.deny`、および `agents.list[].tools`）

これにより、異なるセキュリティ プロファイルで複数のエージェントを実行できます。

- フル アクセスの個人アシスタント
- ツールを制限した家族 / 仕事用エージェント
- サンドボックス内の公開向けエージェント

`setupCommand` は `sandbox.docker`（グローバルまたはエージェントごと）の配下に属し、コンテナ作成時に一度だけ実行されます。

認証はエージェント単位です。各エージェントは次の場所にある自身の `agentDir` 認証ストアを読み取ります。

```
~/.openclaw/agents/<agentId>/agent/auth-profiles.json
```

認証情報はエージェント間で共有されません\*\*。 エージェント間で `agentDir` を再利用しないでください。
資格情報はエージェント間で**共有されません**。`agentDir` をエージェント間で再利用しないでください。資格情報を共有したい場合は、`auth-profiles.json` を別のエージェントの `agentDir` にコピーしてください。

実行時の Sandbox の動作については、 [Sandboxing](/gateway/sandboxing) を参照してください。
実行時のサンドボックスの挙動については、[Sandboxing](/gateway/sandboxing) を参照してください。
「なぜブロックされるのか？」のデバッグについては、[Sandbox vs Tool Policy vs Elevated](/gateway/sandbox-vs-tool-policy-vs-elevated) と `openclaw sandbox explain` を参照してください。

---

## 設定例

### 例 1: 個人用 + 制限付き家族用エージェント

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

**結果:**

- `main` エージェント: ホスト上で実行、ツールはフル アクセス
- `family` エージェント: Docker 内で実行（エージェントごとに 1 コンテナ）、`read` ツールのみ

---

### 例 2: 共有サンドボックスの仕事用エージェント

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

### 例 2b: グローバルなコーディング プロファイル + メッセージング専用エージェント

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

**結果:**

- デフォルトのエージェントはコーディング ツールを使用可能
- `support` エージェントはメッセージング専用（+ Slack ツール）

---

### 例 3: エージェントごとに異なるサンドボックス モード

```json
{
  "agents": {
    "defaults": {
      "sandbox": {
        "mode": "non-main", // Global default
        "scope": "session"
      }
    },
    "list": [
      {
        "id": "main",
        "workspace": "~/.openclaw/workspace",
        "sandbox": {
          "mode": "off" // Override: main never sandboxed
        }
      },
      {
        "id": "public",
        "workspace": "~/.openclaw/workspace-public",
        "sandbox": {
          "mode": "all", // Override: public always sandboxed
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

グローバル（`agents.defaults.*`）とエージェント固有（`agents.list[].*`）の設定が両方存在する場合:

### サンドボックス設定

エージェント固有の設定がグローバルを上書きします。

```
agents.list[].sandbox.mode > agents.defaults.sandbox.mode
agents.list[].sandbox.scope > agents.defaults.sandbox.scope
agents.list[].sandbox.workspaceRoot > agents.defaults.sandbox.workspaceRoot
agents.list[].sandbox.workspaceAccess > agents.defaults.sandbox.workspaceAccess
agents.list[].sandbox.docker.* > agents.defaults.sandbox.docker.*
agents.list[].sandbox.browser.* > agents.defaults.sandbox.browser.*
agents.list[].sandbox.prune.* > agents.defaults.sandbox.prune.*
```

**注記:**

- そのエージェントでは `agents.list[].sandbox.{docker,browser,prune}.*` が `agents.defaults.sandbox.{docker,browser,prune}.*` を上書きします（サンドボックス スコープが `"shared"` に解決される場合は無視されます）。

### ツール制限

フィルタリング順は次のとおりです。

1. **ツール プロファイル**（`tools.profile` または `agents.list[].tools.profile`）
2. **プロバイダー ツール プロファイル**（`tools.byProvider[provider].profile` または `agents.list[].tools.byProvider[provider].profile`）
3. **グローバル ツール ポリシー**（`tools.allow` / `tools.deny`）
4. **プロバイダー ツール ポリシー**（`tools.byProvider[provider].allow/deny`）
5. **エージェント固有のツール ポリシー**（`agents.list[].tools.allow/deny`）
6. **エージェント プロバイダー ポリシー**（`agents.list[].tools.byProvider[provider].allow/deny`）
7. **サンドボックス ツール ポリシー**（`tools.sandbox.tools` または `agents.list[].tools.sandbox.tools`）
8. **サブエージェント ツール ポリシー**（`tools.subagents.tools`、該当する場合）

各レベルはさらにツールを制限できますが、以前のレベルから拒否されたツールを許可することはできません。
`agents.list[].tools.sandbox.tools` が設定されている場合、`tools.sandbox.tools` に置き換えられます。
`agents.list[].tools.profile` が設定されている場合、そのエージェントの `tools.profile` が上書きされます。
プロバイダのツールキーは、`provider`（例：`google-antigubity`）または`provider/model`（例：`openai/gpt-5.2`）のいずれかを受け付けます。

### ツール グループ（ショートハンド）

ツール ポリシー（グローバル、エージェント、サンドボックス）は、複数の具体的なツールに展開される `group:*` エントリをサポートします。

- `group:runtime`: `exec`, `bash`, `process`
- `group:fs`: `read`, `write`, `edit`, `apply_patch`
- `group:sessions`: `sessions_list`, `sessions_history`, `sessions_send`, `sessions_spawn`, `session_status`
- `group:memory`: `memory_search`, `memory_get`
- `group:ui`: `browser`, `canvas`
- `group:automation`: `cron`, `gateway`
- `group:messaging`: `message`
- `group:nodes`: `nodes`
- `group:openclaw`: すべての組み込み OpenClaw ツール（プロバイダー プラグインは除外）

### Elevated モード

`tools.elevated` はグローバルベースライン(送信者ベースの許可リスト)です。 `tools.elevated` はグローバルのベースライン（送信者ベースの許可リスト）です。`agents.list[].tools.elevated` は、特定のエージェントに対して Elevated をさらに制限できます（両方で許可される必要があります）。

緩和パターン:

- 信頼できないエージェントでは `exec` を拒否（`agents.list[].tools.deny: ["exec"]`）
- 制限付きエージェントへルーティングされる送信者を許可リストに追加しない
- サンドボックス化された実行のみを望む場合は、グローバルで Elevated を無効化（`tools.elevated.enabled: false`）
- 機微なプロファイルでは、エージェント単位で Elevated を無効化（`agents.list[].tools.elevated.enabled: false`）

---

## 単一エージェントからの移行

**Before（単一エージェント）:**

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

**After（異なるプロファイルのマルチエージェント）:**

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

レガシーの `agent.*` 設定は `openclaw doctor` により移行されます。今後は `agents.defaults` + `agents.list` を推奨します。

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

### 安全実行エージェント（ファイル変更なし）

```json
{
  "tools": {
    "allow": ["read", "exec", "process"],
    "deny": ["write", "edit", "apply_patch", "browser", "gateway"]
  }
}
```

### 通信専用エージェント

```json
{
  "tools": {
    "allow": ["sessions_list", "sessions_send", "sessions_history", "session_status"],
    "deny": ["exec", "write", "edit", "apply_patch", "read", "browser"]
  }
}
```

---

## よくある落とし穴: 「non-main」

`agents.defaults.sandbox.mode: "non-main"` はエージェント ID ではなく、`session.mainKey`（デフォルトは `"main"`）に基づきます。
グループ / チャンネル セッションは常に独自のキーを取得するため、non-main として扱われ、サンドボックス化されます。エージェントを常にサンドボックス化しない場合は、`agents.list[].sandbox.mode: "off"` を設定してください。 グループ/チャネルセッションは常に独自のキーを取得するため、
はメインではないものとして扱われ、サンドボックス化されます。 もしエージェントに
サンドボックスを渡さないようにしたい場合は、 `agents.list[].sandbox.mode: "off"` を設定します。

---

## テスト

マルチエージェントのサンドボックスとツールを設定した後:

1. **エージェント解決の確認:**

   ```exec
   openclaw agents list --bindings
   ```

2. **サンドボックス コンテナの確認:**

   ```exec
   docker ps --filter "name=openclaw-sbx-"
   ```

3. **ツール制限のテスト:**
   - 制限されたツールを必要とするメッセージを送信
   - 拒否されたツールをエージェントが使用できないことを確認

4. **ログの監視:**

   ```exec
   tail -f "${OPENCLAW_STATE_DIR:-$HOME/.openclaw}/logs/gateway.log" | grep -E "routing|sandbox|tools"
   ```

---

## トラブルシューティング

### `mode: "all"` にもかかわらずエージェントがサンドボックス化されない

- 上書きするグローバルの `agents.defaults.sandbox.mode` がないか確認
- エージェント固有の設定が優先されるため、`agents.list[].sandbox.mode: "all"` を設定

### 拒否リストがあるのにツールが使用可能なまま

- ツールのフィルタリング順を確認: グローバル → エージェント → サンドボックス → サブエージェント
- 各レベルは制限のみ可能で、再付与は不可
- ログで確認: `[tools] filtering tools for agent:${agentId}`

### エージェントごとにコンテナが分離されない

- エージェント固有のサンドボックス設定で `scope: "agent"` を設定
- デフォルトは `"session"` で、セッションごとに 1 コンテナを作成

---

## See Also

- [Multi-Agent Routing](/concepts/multi-agent)
- [Sandbox Configuration](/gateway/configuration#agentsdefaults-sandbox)
- [Session Management](/concepts/session)
