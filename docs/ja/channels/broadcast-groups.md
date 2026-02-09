---
summary: "WhatsApp メッセージを複数のエージェントにブロードキャストする"
read_when:
  - ブロードキャストグループの設定
  - WhatsApp におけるマルチエージェント返信のデバッグ
status: experimental
title: "Broadcast Groups"
---

# Broadcast Groups

**ステータス:** Experimental  
**バージョン:** 2026.1.9 で追加

## 概要

Broadcast Groups は、複数のエージェントが同じメッセージを同時に処理して応答できるようにします。これにより、1 つの電話番号を使用した単一の WhatsApp グループまたはダイレクトメッセージ内で、連携して動作する専門エージェントチームを作成できます。 これにより、1つの電話番号を使用して、1つのWhatsAppグループまたはDMで協力する特別なエージェントチームを作成できます。

現在の対応範囲: **WhatsApp のみ**（Web チャンネル）。

ブロードキャストグループは、チャンネル許可リストとグループの有効化ルールの後に評価されます。 Broadcast Groups は、チャンネルの許可リストおよびグループ有効化ルールの後に評価されます。WhatsApp グループでは、これは OpenClaw が通常返信する条件（例: グループ設定に応じたメンション時）でブロードキャストが行われることを意味します。

## ユースケース

### 1. 専門エージェントチーム

原子的で焦点を絞った責務を持つ複数のエージェントをデプロイします。

```
Group: "Development Team"
Agents:
  - CodeReviewer (reviews code snippets)
  - DocumentationBot (generates docs)
  - SecurityAuditor (checks for vulnerabilities)
  - TestGenerator (suggests test cases)
```

各エージェントは同じメッセージを処理し、それぞれの専門的な観点を提供します。

### 2. 多言語サポート

```
Group: "International Support"
Agents:
  - Agent_EN (responds in English)
  - Agent_DE (responds in German)
  - Agent_ES (responds in Spanish)
```

### 3. 品質保証ワークフロー

```
Group: "Customer Support"
Agents:
  - SupportAgent (provides answer)
  - QAAgent (reviews quality, only responds if issues found)
```

### 4. タスク自動化

```
Group: "Project Management"
Agents:
  - TaskTracker (updates task database)
  - TimeLogger (logs time spent)
  - ReportGenerator (creates summaries)
```

## 設定

### 基本セットアップ

トップレベルの `broadcast` セクション（`bindings`の横）を追加します。 鍵はWhatsAppピアIDです:

- グループチャット: グループ JID（例: `120363403215116621@g.us`）
- ダイレクトメッセージ: E.164 電話番号（例: `+15551234567`）

```json
{
  "broadcast": {
    "120363403215116621@g.us": ["alfred", "baerbel", "assistant3"]
  }
}
```

**結果:** OpenClaw がこのチャットで返信する場合、3 つすべてのエージェントが実行されます。

### 処理戦略

エージェントがメッセージを処理する方法を制御します。

#### 並列（デフォルト）

すべてのエージェントが同時に処理します。

```json
{
  "broadcast": {
    "strategy": "parallel",
    "120363403215116621@g.us": ["alfred", "baerbel"]
  }
}
```

#### 逐次

エージェントが順番に処理します（前のエージェントの完了を待機）。

```json
{
  "broadcast": {
    "strategy": "sequential",
    "120363403215116621@g.us": ["alfred", "baerbel"]
  }
}
```

### 完全な例

```json
{
  "agents": {
    "list": [
      {
        "id": "code-reviewer",
        "name": "Code Reviewer",
        "workspace": "/path/to/code-reviewer",
        "sandbox": { "mode": "all" }
      },
      {
        "id": "security-auditor",
        "name": "Security Auditor",
        "workspace": "/path/to/security-auditor",
        "sandbox": { "mode": "all" }
      },
      {
        "id": "docs-generator",
        "name": "Documentation Generator",
        "workspace": "/path/to/docs-generator",
        "sandbox": { "mode": "all" }
      }
    ]
  },
  "broadcast": {
    "strategy": "parallel",
    "120363403215116621@g.us": ["code-reviewer", "security-auditor", "docs-generator"],
    "120363424282127706@g.us": ["support-en", "support-de"],
    "+15555550123": ["assistant", "logger"]
  }
}
```

## 仕組み

### メッセージフロー

1. **受信メッセージ** が WhatsApp グループに到着
2. **ブロードキャストチェック**: システムがピア ID が `broadcast` に含まれているかを確認
3. **ブロードキャストリストに含まれる場合**:
   - 一覧にあるすべてのエージェントがメッセージを処理
   - 各エージェントは独自のセッションキーと分離されたコンテキストを保持
   - エージェントは並列（デフォルト）または逐次で処理
4. **ブロードキャストリストに含まれない場合**:
   - 通常のルーティングが適用されます（最初に一致したバインディング）

注記: Broadcast Groups は、チャンネルの許可リストやグループ有効化ルール（メンションやコマンドなど）をバイパスしません。メッセージが処理対象になった際に「どのエージェントが実行されるか」のみを変更します。 メッセージが処理対象である場合にのみ、_どのエージェントが実行されるかを変更します。

### セッションの分離

Broadcast Groups 内の各エージェントは、以下を完全に分離して維持します。

- **セッションキー**（`agent:alfred:whatsapp:group:120363...` と `agent:baerbel:whatsapp:group:120363...`）
- **会話履歴**（他のエージェントのメッセージは見えません）
- **ワークスペース**（設定されている場合は別々のサンドボックス）
- **ツールアクセス**（異なる許可／拒否リスト）
- **メモリ／コンテキスト**（別々の IDENTITY.md、SOUL.md など）
- **グループコンテキストバッファ**（コンテキストとして使用される最近のグループメッセージ）はピアごとに共有されるため、トリガー時にすべてのブロードキャストエージェントが同じコンテキストを参照します。

これにより、各エージェントは以下を持つことができます。

- 異なるパーソナリティ
- 異なるツールアクセス（例: 読み取り専用と読み書き）
- 異なるモデル（例: opus と sonnet）
- 異なる Skills のインストール

### 例: 分離されたセッション

グループ `120363403215116621@g.us` にエージェント `["alfred", "baerbel"]` が存在する場合:

**Alfred のコンテキスト:**

```
Session: agent:alfred:whatsapp:group:120363403215116621@g.us
History: [user message, alfred's previous responses]
Workspace: /Users/pascal/openclaw-alfred/
Tools: read, write, exec
```

**Bärbel のコンテキスト:**

```
Session: agent:baerbel:whatsapp:group:120363403215116621@g.us
History: [user message, baerbel's previous responses]
Workspace: /Users/pascal/openclaw-baerbel/
Tools: read only
```

## ベストプラクティス

### 1. エージェントを集中させる

各エージェントを単一で明確な責務を持つように設計します。

```json
{
  "broadcast": {
    "DEV_GROUP": ["formatter", "linter", "tester"]
  }
}
```

✅ **良い例:** 各エージェントが 1 つの役割を持つ  
❌ **悪い例:** 汎用的な「dev-helper」エージェント 1 つ

### 2. 説明的な名前を使用する

各エージェントが何をするのかを明確にします。

```json
{
  "agents": {
    "security-scanner": { "name": "Security Scanner" },
    "code-formatter": { "name": "Code Formatter" },
    "test-generator": { "name": "Test Generator" }
  }
}
```

### 3. 異なるツールアクセスを設定する

エージェントには必要なツールのみを付与します。

```json
{
  "agents": {
    "reviewer": {
      "tools": { "allow": ["read", "exec"] } // Read-only
    },
    "fixer": {
      "tools": { "allow": ["read", "write", "edit", "exec"] } // Read-write
    }
  }
}
```

### 4. パフォーマンスを監視する

多数のエージェントを使用する場合は、以下を検討してください。

- 速度のために `"strategy": "parallel"`（デフォルト）を使用
- ブロードキャストグループを 5～10 エージェントに制限
- 単純なエージェントには高速なモデルを使用

### 5. 障害を適切に処理する

エージェントは独立して失敗します。 エージェントは独立して失敗します。1 つのエージェントのエラーが他をブロックすることはありません。

```
Message → [Agent A ✓, Agent B ✗ error, Agent C ✓]
Result: Agent A and C respond, Agent B logs error
```

## 互換性

### プロバイダー

Broadcast Groups は現在、以下で動作します。

- ✅ WhatsApp（実装済み）
- 🚧 Telegram（予定）
- 🚧 Discord（予定）
- 🚧 Slack（予定）

### ルーティング

Broadcast Groups は既存のルーティングと併用されます。

```json
{
  "bindings": [
    {
      "match": { "channel": "whatsapp", "peer": { "kind": "group", "id": "GROUP_A" } },
      "agentId": "alfred"
    }
  ],
  "broadcast": {
    "GROUP_B": ["agent1", "agent2"]
  }
}
```

- `GROUP_A`: alfred のみが応答（通常のルーティング）
- `GROUP_B`: agent1 と agent2 の両方が応答（ブロードキャスト）

**優先順位:** `broadcast` が `bindings` より優先されます。

## トラブルシューティング

### エージェントが応答しない

**確認事項:**

1. エージェント ID が `agents.list` に存在する
2. ピア ID の形式が正しい（例: `120363403215116621@g.us`）
3. エージェントが拒否リストに含まれていない

**デバッグ:**

```bash
tail -f ~/.openclaw/logs/gateway.log | grep broadcast
```

### 1 つのエージェントのみが応答する

**原因:** ピア ID が `bindings` には含まれているが、`broadcast` には含まれていない可能性があります。

**対処:** ブロードキャスト設定に追加するか、バインディングから削除します。

### パフォーマンスの問題

**多数のエージェントで遅い場合:**

- グループあたりのエージェント数を減らす
- 軽量なモデルを使用する（opus の代わりに sonnet）
- サンドボックスの起動時間を確認

## 例

### 例 1: コードレビューチーム

```json
{
  "broadcast": {
    "strategy": "parallel",
    "120363403215116621@g.us": [
      "code-formatter",
      "security-scanner",
      "test-coverage",
      "docs-checker"
    ]
  },
  "agents": {
    "list": [
      {
        "id": "code-formatter",
        "workspace": "~/agents/formatter",
        "tools": { "allow": ["read", "write"] }
      },
      {
        "id": "security-scanner",
        "workspace": "~/agents/security",
        "tools": { "allow": ["read", "exec"] }
      },
      {
        "id": "test-coverage",
        "workspace": "~/agents/testing",
        "tools": { "allow": ["read", "exec"] }
      },
      { "id": "docs-checker", "workspace": "~/agents/docs", "tools": { "allow": ["read"] } }
    ]
  }
}
```

**ユーザー送信:** コードスニペット  
**応答:**

- code-formatter: 「インデントを修正し、型ヒントを追加しました」
- security-scanner: 「⚠️ 12 行目に SQL インジェクションの脆弱性があります」
- test-coverage: 「カバレッジは 45% です。エラーケースのテストが不足しています」
- docs-checker: 「関数 `process_data` に docstring がありません」

### 例 2: 多言語サポート

```json
{
  "broadcast": {
    "strategy": "sequential",
    "+15555550123": ["detect-language", "translator-en", "translator-de"]
  },
  "agents": {
    "list": [
      { "id": "detect-language", "workspace": "~/agents/lang-detect" },
      { "id": "translator-en", "workspace": "~/agents/translate-en" },
      { "id": "translator-de", "workspace": "~/agents/translate-de" }
    ]
  }
}
```

## API リファレンス

### 設定スキーマ

```typescript
interface OpenClawConfig {
  broadcast?: {
    strategy?: "parallel" | "sequential";
    [peerId: string]: string[];
  };
}
```

### フィールド

- `strategy`（任意）: エージェントの処理方法
  - `"parallel"`（デフォルト）: すべてのエージェントが同時に処理
  - `"sequential"`: 配列順にエージェントが処理
- `[peerId]`: WhatsApp グループ JID、E.164 番号、またはその他のピア ID
  - 値: メッセージを処理するエージェント ID の配列

## 制限事項

1. **最大エージェント数:** 明確な上限はありませんが、10 以上のエージェントでは遅くなる可能性があります。
2. **共有コンテキスト:** エージェント同士は互いの応答を見ません（設計によるものです）。
3. **メッセージ順序:** 並列応答は任意の順序で到着する可能性があります。
4. **レート制限:** すべてのエージェントが WhatsApp のレート制限にカウントされます。

## 将来の拡張

予定されている機能:

- [ ] 共有コンテキストモード（エージェントが互いの応答を参照）
- [ ] エージェント連携（エージェント同士がシグナルを送信）
- [ ] 動的エージェント選択（メッセージ内容に基づいてエージェントを選択）
- [ ] エージェント優先度（一部のエージェントが先に応答）

## See Also

- [Multi-Agent Configuration](/tools/multi-agent-sandbox-tools)
- [Routing Configuration](/channels/channel-routing)
- [Session Management](/concepts/sessions)
