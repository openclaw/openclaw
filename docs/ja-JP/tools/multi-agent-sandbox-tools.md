---
summary: "エージェントごとのサンドボックス・ツール制限、優先順位、および例"
title: マルチエージェントサンドボックスとツール
read_when: "マルチエージェント Gateway でエージェントごとのサンドボックスまたはエージェントごとのツール許可・拒否ポリシーが必要な場合。"
status: active
---

# マルチエージェントサンドボックスとツールの設定

## 概要

マルチエージェント設定の各エージェントは、独自の設定を持てるようになりました:

- **サンドボックス設定**（`agents.list[].sandbox` が `agents.defaults.sandbox` を上書きします）
- **ツール制限**（`tools.allow` / `tools.deny`、さらに `agents.list[].tools`）

これにより、異なるセキュリティプロファイルを持つ複数のエージェントを実行できます:

- フルアクセスのパーソナルアシスタント
- ツールが制限されたファミリー・仕事用エージェント
- サンドボックス内の公開向けエージェント

`setupCommand` は `sandbox.docker`（グローバルまたはエージェントごと）の下に属し、
コンテナが作成されるときに 1 度だけ実行されます。

認証はエージェントごとです: 各エージェントは以下の場所にある独自の `agentDir` 認証ストアから読み取ります:

```
~/.openclaw/agents/<agentId>/agent/auth-profiles.json
```

認証情報はエージェント間で**共有されません**。エージェント間で `agentDir` を再利用しないでください。
認証情報を共有したい場合は、`auth-profiles.json` を他のエージェントの `agentDir` にコピーしてください。

実行時のサンドボックスの動作については [サンドボックス](/gateway/sandboxing) を参照してください。
「なぜブロックされているのか」のデバッグには、[サンドボックス対ツールポリシー対昇格モード](/gateway/sandbox-vs-tool-policy-vs-elevated) と `openclaw sandbox explain` を参照してください。

---

## 設定例

### 例 1: パーソナル + 制限付きファミリーエージェント

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

- `main` エージェント: ホストで実行、フルツールアクセス
- `family` エージェント: Docker で実行（エージェントごとに 1 コンテナ）、`read` ツールのみ

---

### 例 2: 共有サンドボックスを持つ仕事用エージェント

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

### 例 2b: グローバルコーディングプロファイル + メッセージングのみのエージェント

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

- デフォルトエージェントはコーディングツールを取得
- `support` エージェントはメッセージングのみ（+ Slack ツール）

---

### 例 3: エージェントごとに異なるサンドボックスモード

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
          "mode": "off" // オーバーライド: main は決してサンドボックス化されない
        }
      },
      {
        "id": "public",
        "workspace": "~/.openclaw/workspace-public",
        "sandbox": {
          "mode": "all", // オーバーライド: public は常にサンドボックス化される
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

グローバル（`agents.defaults.*`）とエージェント固有（`agents.list[].*`）の両方の設定が存在する場合:

### サンドボックス設定

エージェント固有の設定がグローバルを上書きします:

```
agents.list[].sandbox.mode > agents.defaults.sandbox.mode
agents.list[].sandbox.scope > agents.defaults.sandbox.scope
agents.list[].sandbox.workspaceRoot > agents.defaults.sandbox.workspaceRoot
agents.list[].sandbox.workspaceAccess > agents.defaults.sandbox.workspaceAccess
agents.list[].sandbox.docker.* > agents.defaults.sandbox.docker.*
agents.list[].sandbox.browser.* > agents.defaults.sandbox.browser.*
agents.list[].sandbox.prune.* > agents.defaults.sandbox.prune.*
```

**注意事項:**

- `agents.list[].sandbox.{docker,browser,prune}.*` はそのエージェントの `agents.defaults.sandbox.{docker,browser,prune}.*` を上書きします（サンドボックススコープが `"shared"` に解決される場合は無視されます）。

### ツール制限

フィルタリングの順序:

1. **ツールプロファイル**（`tools.profile` または `agents.list[].tools.profile`）
2. **プロバイダーツールプロファイル**（`tools.byProvider[provider].profile` または `agents.list[].tools.byProvider[provider].profile`）
3. **グローバルツールポリシー**（`tools.allow` / `tools.deny`）
4. **プロバイダーツールポリシー**（`tools.byProvider[provider].allow/deny`）
5. **エージェント固有のツールポリシー**（`agents.list[].tools.allow/deny`）
6. **エージェントプロバイダーポリシー**（`agents.list[].tools.byProvider[provider].allow/deny`）
7. **サンドボックスツールポリシー**（`tools.sandbox.tools` または `agents.list[].tools.sandbox.tools`）
8. **サブエージェントツールポリシー**（`tools.subagents.tools`、該当する場合）

各レベルはツールをさらに制限できますが、以前のレベルで拒否されたツールを復元することはできません。
`agents.list[].tools.sandbox.tools` が設定されている場合、そのエージェントの `tools.sandbox.tools` を置き換えます。
`agents.list[].tools.profile` が設定されている場合、そのエージェントの `tools.profile` を上書きします。
プロバイダーツールキーには `provider`（例: `google-antigravity`）または `provider/model`（例: `openai/gpt-5.2`）のどちらも使用できます。

### ツールグループ（省略表記）

ツールポリシー（グローバル、エージェント、サンドボックス）は、複数の具体的なツールに展開される `group:*` エントリをサポートしています:

- `group:runtime`: `exec`, `bash`, `process`
- `group:fs`: `read`, `write`, `edit`, `apply_patch`
- `group:sessions`: `sessions_list`, `sessions_history`, `sessions_send`, `sessions_spawn`, `session_status`
- `group:memory`: `memory_search`, `memory_get`
- `group:ui`: `browser`, `canvas`
- `group:automation`: `cron`, `gateway`
- `group:messaging`: `message`
- `group:nodes`: `nodes`
- `group:openclaw`: すべての組み込み OpenClaw ツール（プロバイダープラグインを除く）

### 昇格モード

`tools.elevated` はグローバルベースライン（送信者ベースのアローリスト）です。`agents.list[].tools.elevated` は特定のエージェントの昇格をさらに制限できます（両方が許可する必要があります）。

軽減パターン:

- 信頼されないエージェントの `exec` を拒否する（`agents.list[].tools.deny: ["exec"]`）
- 制限されたエージェントにルーティングする送信者をアローリストに追加しない
- サンドボックス実行のみが必要な場合は昇格をグローバルに無効化する（`tools.elevated.enabled: false`）
- 機密性の高いプロファイルでエージェントごとに昇格を無効化する（`agents.list[].tools.elevated.enabled: false`）

---

## シングルエージェントからの移行

**移行前（シングルエージェント）:**

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

**移行後（異なるプロファイルのマルチエージェント）:**

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

レガシーの `agent.*` 設定は `openclaw doctor` によって移行されます。今後は `agents.defaults` + `agents.list` を優先してください。

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

### コミュニケーションのみのエージェント

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

## よくある落とし穴: 「non-main」

`agents.defaults.sandbox.mode: "non-main"` は `session.mainKey`（デフォルト `"main"`）に基づいており、
エージェント id ではありません。グループ・チャンネルセッションは常に独自のキーを持つため、
non-main として扱われ、サンドボックス化されます。エージェントを絶対にサンドボックス化しない
場合は、`agents.list[].sandbox.mode: "off"` を設定してください。

---

## テスト

マルチエージェントサンドボックスとツールを設定した後:

1. **エージェント解決を確認:**

   ```exec
   openclaw agents list --bindings
   ```

2. **サンドボックスコンテナを確認:**

   ```exec
   docker ps --filter "name=openclaw-sbx-"
   ```

3. **ツール制限をテスト:**
   - 制限されたツールを必要とするメッセージを送信する
   - エージェントが拒否されたツールを使用できないことを確認する

4. **ログを監視:**

   ```exec
   tail -f "${OPENCLAW_STATE_DIR:-$HOME/.openclaw}/logs/gateway.log" | grep -E "routing|sandbox|tools"
   ```

---

## トラブルシューティング

### `mode: "all"` にもかかわらずエージェントがサンドボックス化されない

- それを上書きするグローバルの `agents.defaults.sandbox.mode` がないか確認する
- エージェント固有の設定が優先されるため、`agents.list[].sandbox.mode: "all"` を設定する

### 拒否リストにあるにもかかわらずツールが利用可能

- ツールフィルタリングの順序を確認する: グローバル → エージェント → サンドボックス → サブエージェント
- 各レベルは絞り込みのみ可能で、復元はできません
- ログで確認する: `[tools] filtering tools for agent:${agentId}`

### エージェントごとにコンテナが分離されていない

- エージェント固有のサンドボックス設定に `scope: "agent"` を設定する
- デフォルトは `"session"` で、セッションごとに 1 コンテナを作成します

---

## 関連情報

- [マルチエージェントルーティング](/concepts/multi-agent)
- [サンドボックス設定](/gateway/configuration#agentsdefaults-sandbox)
- [セッション管理](/concepts/session)
