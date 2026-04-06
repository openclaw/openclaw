---
read_when:
    - ブロードキャストグループの設定
    - WhatsAppでのマルチエージェント応答のデバッグ
status: experimental
summary: WhatsAppメッセージを複数のエージェントにブロードキャストする
title: ブロードキャストグループ
x-i18n:
    generated_at: "2026-04-02T08:25:19Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: 1d117ae65ec3b63c2bd4b3c215d96f32d7eafa0f99a9cd7378e502c15e56ca56
    source_path: channels/broadcast-groups.md
    workflow: 15
---

# ブロードキャストグループ

**ステータス:** 実験的  
**バージョン:** 2026.1.9で追加

## 概要

ブロードキャストグループを使用すると、複数のエージェントが同じメッセージを同時に処理して応答できます。これにより、1つのWhatsAppグループまたはダイレクトメッセージ内で、1つの電話番号を使って連携する専門エージェントチームを作成できます。

現在の対象範囲: **WhatsAppのみ**（webチャネル）。

ブロードキャストグループは、チャネルの許可リストとグループのアクティベーションルールの後に評価されます。WhatsAppグループでは、OpenClawが通常返信する場合（例: メンション時、グループ設定に依存）にブロードキャストが実行されます。

## ユースケース

### 1. 専門エージェントチーム

それぞれに明確な責任を持つ複数のエージェントをデプロイします:

```
Group: "Development Team"
Agents:
  - CodeReviewer (reviews code snippets)
  - DocumentationBot (generates docs)
  - SecurityAuditor (checks for vulnerabilities)
  - TestGenerator (suggests test cases)
```

各エージェントが同じメッセージを処理し、専門的な視点を提供します。

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

トップレベルに `broadcast` セクション（`bindings` の隣）を追加します。キーはWhatsAppのピアIDです:

- グループチャット: グループJID（例: `120363403215116621@g.us`）
- ダイレクトメッセージ: E.164形式の電話番号（例: `+15551234567`）

```json
{
  "broadcast": {
    "120363403215116621@g.us": ["alfred", "baerbel", "assistant3"]
  }
}
```

**結果:** このチャットでOpenClawが返信する際、3つのエージェントすべてが実行されます。

### 処理戦略

エージェントのメッセージ処理方法を制御します:

#### パラレル（デフォルト）

すべてのエージェントが同時に処理します:

```json
{
  "broadcast": {
    "strategy": "parallel",
    "120363403215116621@g.us": ["alfred", "baerbel"]
  }
}
```

#### シーケンシャル

エージェントが順番に処理します（前のエージェントの完了を待ちます）:

```json
{
  "broadcast": {
    "strategy": "sequential",
    "120363403215116621@g.us": ["alfred", "baerbel"]
  }
}
```

### 完全な設定例

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

## 動作の仕組み

### メッセージフロー

1. **受信メッセージ**がWhatsAppグループに到着
2. **ブロードキャストチェック**: システムがピアIDが `broadcast` に含まれているか確認
3. **ブロードキャストリストに含まれる場合**:
   - リストされたすべてのエージェントがメッセージを処理
   - 各エージェントは独自のセッションキーと分離されたコンテキストを持つ
   - エージェントはパラレル（デフォルト）またはシーケンシャルで処理
4. **ブロードキャストリストに含まれない場合**:
   - 通常のルーティングが適用（最初にマッチするバインディング）

注意: ブロードキャストグループは、チャネルの許可リストやグループのアクティベーションルール（メンション/コマンドなど）をバイパスしません。メッセージが処理対象となった場合に、_どのエージェントが実行されるか_ を変更するだけです。

### セッションの分離

ブロードキャストグループ内の各エージェントは、以下を完全に独立して維持します:

- **セッションキー**（`agent:alfred:whatsapp:group:120363...` vs `agent:baerbel:whatsapp:group:120363...`）
- **会話履歴**（他のエージェントのメッセージは見えない）
- **ワークスペース**（設定されている場合は個別のサンドボックス）
- **ツールアクセス**（異なる許可/拒否リスト）
- **メモリ/コンテキスト**（個別のIDENTITY.md、SOUL.mdなど）
- **グループコンテキストバッファ**（コンテキストに使用される最近のグループメッセージ）はピアごとに共有されるため、トリガー時にすべてのブロードキャストエージェントが同じコンテキストを参照

これにより、各エージェントは以下を持つことができます:

- 異なるパーソナリティ
- 異なるツールアクセス（例: 読み取り専用 vs. 読み書き可能）
- 異なるモデル（例: opus vs. sonnet）
- 異なる Skills のインストール

### 例: 分離されたセッション

グループ `120363403215116621@g.us` でエージェント `["alfred", "baerbel"]` の場合:

**Alfredのコンテキスト:**

```
Session: agent:alfred:whatsapp:group:120363403215116621@g.us
History: [user message, alfred's previous responses]
Workspace: /Users/user/openclaw-alfred/
Tools: read, write, exec
```

**Bärbelのコンテキスト:**

```
Session: agent:baerbel:whatsapp:group:120363403215116621@g.us
History: [user message, baerbel's previous responses]
Workspace: /Users/user/openclaw-baerbel/
Tools: read only
```

## ベストプラクティス

### 1. エージェントは単一の役割に集中させる

各エージェントに明確で単一の責任を持たせて設計します:

```json
{
  "broadcast": {
    "DEV_GROUP": ["formatter", "linter", "tester"]
  }
}
```

✅ **良い例:** 各エージェントが1つの仕事を持つ  
❌ **悪い例:** 1つの汎用的な「dev-helper」エージェント

### 2. わかりやすい名前を使う

各エージェントの役割がわかる名前にします:

```json
{
  "agents": {
    "security-scanner": { "name": "Security Scanner" },
    "code-formatter": { "name": "Code Formatter" },
    "test-generator": { "name": "Test Generator" }
  }
}
```

### 3. ツールアクセスを個別に設定する

エージェントには必要なツールのみを付与します:

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

エージェント数が多い場合は、以下を検討してください:

- 速度のために `"strategy": "parallel"`（デフォルト）を使用
- ブロードキャストグループのエージェント数を5〜10に制限
- シンプルなエージェントにはより高速なモデルを使用

### 5. 障害を適切に処理する

エージェントは独立して失敗します。1つのエージェントのエラーが他のエージェントをブロックすることはありません:

```
Message → [Agent A ✓, Agent B ✗ error, Agent C ✓]
Result: Agent A and C respond, Agent B logs error
```

## 互換性

### プロバイダー

ブロードキャストグループは現在以下で動作します:

- ✅ WhatsApp（実装済み）
- 🚧 Telegram（予定）
- 🚧 Discord（予定）
- 🚧 Slack（予定）

### ルーティング

ブロードキャストグループは既存のルーティングと併用できます:

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

- `GROUP_A`: alfredのみが応答（通常のルーティング）
- `GROUP_B`: agent1とagent2の両方が応答（ブロードキャスト）

**優先順位:** `broadcast` は `bindings` より優先されます。

## トラブルシューティング

### エージェントが応答しない

**確認事項:**

1. エージェントIDが `agents.list` に存在するか
2. ピアIDの形式が正しいか（例: `120363403215116621@g.us`）
3. エージェントが拒否リストに含まれていないか

**デバッグ:**

```bash
tail -f ~/.openclaw/logs/gateway.log | grep broadcast
```

### 1つのエージェントしか応答しない

**原因:** ピアIDが `bindings` にはあるが `broadcast` にない可能性があります。

**修正:** ブロードキャスト設定に追加するか、バインディングから削除してください。

### パフォーマンスの問題

**エージェント数が多く遅い場合:**

- グループあたりのエージェント数を減らす
- 軽量なモデルを使用する（opusの代わりにsonnet）
- サンドボックスの起動時間を確認する

## 設定例

### 例1: コードレビューチーム

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

**ユーザーが送信:** コードスニペット  
**応答:**

- code-formatter:「インデントを修正し、型ヒントを追加しました」
- security-scanner:「⚠️ 12行目にSQLインジェクションの脆弱性があります」
- test-coverage:「カバレッジは45%です。エラーケースのテストが不足しています」
- docs-checker:「関数 `process_data` のdocstringがありません」

### 例2: 多言語サポート

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

## APIリファレンス

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

- `strategy`（オプション）: エージェントの処理方法
  - `"parallel"`（デフォルト）: すべてのエージェントが同時に処理
  - `"sequential"`: エージェントが配列の順序で処理
- `[peerId]`: WhatsAppグループJID、E.164番号、またはその他のピアID
  - 値: メッセージを処理するエージェントIDの配列

## 制限事項

1. **最大エージェント数:** ハードリミットはありませんが、10以上のエージェントでは遅くなる可能性があります
2. **共有コンテキスト:** エージェントは他のエージェントの応答を見ることができません（設計上の意図）
3. **メッセージの順序:** パラレル応答は任意の順序で到着する可能性があります
4. **レート制限:** すべてのエージェントがWhatsAppのレート制限にカウントされます

## 今後の機能強化

計画中の機能:

- [ ] 共有コンテキストモード（エージェントが互いの応答を参照可能）
- [ ] エージェント間の連携（エージェントが互いにシグナルを送信可能）
- [ ] 動的エージェント選択（メッセージの内容に基づいてエージェントを選択）
- [ ] エージェントの優先度（一部のエージェントが他より先に応答）

## 関連項目

- [マルチエージェント設定](/tools/multi-agent-sandbox-tools)
- [ルーティング設定](/channels/channel-routing)
- [セッション管理](/concepts/session)
