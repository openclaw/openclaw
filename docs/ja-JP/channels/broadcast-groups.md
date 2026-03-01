---
summary: "WhatsAppメッセージを複数のエージェントにブロードキャスト"
read_when:
  - ブロードキャストグループを設定するとき
  - WhatsAppでのマルチエージェント返信をデバッグするとき
status: experimental
title: "ブロードキャストグループ"
---

# ブロードキャストグループ

**ステータス:** 実験的
**バージョン:** 2026.1.9で追加

## 概要

ブロードキャストグループにより、複数のエージェントが同じメッセージを同時に処理して応答できます。これにより、1つの電話番号を使用して、単一のWhatsAppグループまたはDMで連携する専門エージェントチームを作成できます。

現在のスコープ: **WhatsAppのみ**（Webチャンネル）。

ブロードキャストグループはチャンネル許可リストとグループアクティベーションルールの後に評価されます。WhatsAppグループでは、OpenClawが通常返信するタイミング（例: グループ設定に応じてメンション時）でブロードキャストが発生します。

## ユースケース

### 1. 専門エージェントチーム

原子的で焦点を絞った責任を持つ複数のエージェントをデプロイします:

```
グループ: "Development Team"
エージェント:
  - CodeReviewer（コードスニペットをレビュー）
  - DocumentationBot（ドキュメントを生成）
  - SecurityAuditor（脆弱性をチェック）
  - TestGenerator（テストケースを提案）
```

各エージェントは同じメッセージを処理し、専門的な視点を提供します。

### 2. 多言語サポート

```
グループ: "International Support"
エージェント:
  - Agent_EN（英語で応答）
  - Agent_DE（ドイツ語で応答）
  - Agent_ES（スペイン語で応答）
```

### 3. 品質保証ワークフロー

```
グループ: "Customer Support"
エージェント:
  - SupportAgent（回答を提供）
  - QAAgent（品質をレビューし、問題がある場合のみ応答）
```

### 4. タスク自動化

```
グループ: "Project Management"
エージェント:
  - TaskTracker（タスクデータベースを更新）
  - TimeLogger（費やした時間を記録）
  - ReportGenerator（要約を作成）
```

## 設定

### 基本セットアップ

トップレベルに`broadcast`セクションを追加します（`bindings`の隣）。キーはWhatsAppのピアIDです:

- グループチャット: グループJID（例: `120363403215116621@g.us`）
- DM: E.164電話番号（例: `+15551234567`）

```json
{
  "broadcast": {
    "120363403215116621@g.us": ["alfred", "baerbel", "assistant3"]
  }
}
```

**結果:** OpenClawがこのチャットで返信するタイミングで、3つのエージェントすべてが実行されます。

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

## 動作の仕組み

### メッセージフロー

1. **受信メッセージ**がWhatsAppグループに到着します
2. **ブロードキャストチェック**: システムがピアIDが`broadcast`にあるか確認します
3. **ブロードキャストリストにある場合**:
   - リストされたすべてのエージェントがメッセージを処理します
   - 各エージェントは独自のセッションキーと分離されたコンテキストを持ちます
   - エージェントはパラレル（デフォルト）またはシーケンシャルで処理します
4. **ブロードキャストリストにない場合**:
   - 通常のルーティングが適用されます（最初にマッチするバインディング）

注意: ブロードキャストグループはチャンネル許可リストやグループアクティベーションルール（メンション/コマンドなど）をバイパスしません。メッセージが処理対象の場合に、_どのエージェントが実行されるか_のみを変更します。

### セッション分離

ブロードキャストグループ内の各エージェントは完全に分離された以下を維持します:

- **セッションキー**（`agent:alfred:whatsapp:group:120363...` vs `agent:baerbel:whatsapp:group:120363...`）
- **会話履歴**（エージェントは他のエージェントのメッセージを見ません）
- **ワークスペース**（設定されている場合は別のサンドボックス）
- **ツールアクセス**（異なる許可/拒否リスト）
- **メモリ/コンテキスト**（別々のIDENTITY.md、SOUL.mdなど）
- **グループコンテキストバッファ**（コンテキストとして使用される最近のグループメッセージ）はピアごとに共有されるため、すべてのブロードキャストエージェントはトリガー時に同じコンテキストを参照します

これにより各エージェントは以下を持つことができます:

- 異なるパーソナリティ
- 異なるツールアクセス（例: 読み取り専用 vs 読み書き可能）
- 異なるモデル（例: opus vs sonnet）
- 異なるスキルのインストール

### 例: 分離されたセッション

グループ`120363403215116621@g.us`でエージェント`["alfred", "baerbel"]`の場合:

**Alfredのコンテキスト:**

```
Session: agent:alfred:whatsapp:group:120363403215116621@g.us
History: [ユーザーメッセージ, alfredの以前の応答]
Workspace: /Users/pascal/openclaw-alfred/
Tools: read, write, exec
```

**Barbelのコンテキスト:**

```
Session: agent:baerbel:whatsapp:group:120363403215116621@g.us
History: [ユーザーメッセージ, barbelの以前の応答]
Workspace: /Users/pascal/openclaw-baerbel/
Tools: read only
```

## ベストプラクティス

### 1. エージェントを焦点化する

各エージェントに単一の明確な責任を設計します:

```json
{
  "broadcast": {
    "DEV_GROUP": ["formatter", "linter", "tester"]
  }
}
```

良い例: 各エージェントが1つの仕事を持つ
悪い例: 1つの汎用的な"dev-helper"エージェント

### 2. わかりやすい名前を使用する

各エージェントが何をするか明確にします:

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

エージェントに必要なツールのみを付与します:

```json
{
  "agents": {
    "reviewer": {
      "tools": { "allow": ["read", "exec"] }
    },
    "fixer": {
      "tools": { "allow": ["read", "write", "edit", "exec"] }
    }
  }
}
```

### 4. パフォーマンスを監視する

多くのエージェントがある場合、以下を検討してください:

- 速度のために`"strategy": "parallel"`（デフォルト）を使用
- ブロードキャストグループを5-10エージェントに制限
- シンプルなエージェントにはより高速なモデルを使用

### 5. エラーを適切に処理する

エージェントは独立して失敗します。1つのエージェントのエラーが他をブロックしません:

```
Message → [Agent A ✓, Agent B ✗ エラー, Agent C ✓]
結果: Agent AとCが応答、Agent Bはエラーをログに記録
```

## 互換性

### プロバイダー

ブロードキャストグループは現在以下で動作します:

- WhatsApp（実装済み）
- Telegram（計画中）
- Discord（計画中）
- Slack（計画中）

### ルーティング

ブロードキャストグループは既存のルーティングと並行して動作します:

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
- `GROUP_B`: agent1とagent2が応答（ブロードキャスト）

**優先順位:** `broadcast`は`bindings`より優先されます。

## トラブルシューティング

### エージェントが応答しない

**確認:**

1. エージェントIDが`agents.list`に存在するか
2. ピアIDの形式が正しいか（例: `120363403215116621@g.us`）
3. エージェントが拒否リストに入っていないか

**デバッグ:**

```bash
tail -f ~/.openclaw/logs/gateway.log | grep broadcast
```

### 1つのエージェントのみが応答する

**原因:** ピアIDが`bindings`にあるが`broadcast`にない可能性があります。

**修正:** ブロードキャスト設定に追加するか、バインディングから削除してください。

### パフォーマンスの問題

**多くのエージェントで遅い場合:**

- グループあたりのエージェント数を減らす
- より軽量なモデルを使用する（opusの代わりにsonnet）
- サンドボックスの起動時間を確認する

## 例

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

- code-formatter: "インデントを修正し、型ヒントを追加しました"
- security-scanner: "12行目にSQLインジェクションの脆弱性があります"
- test-coverage: "カバレッジは45%で、エラーケースのテストが不足しています"
- docs-checker: "関数`process_data`のdocstringが不足しています"

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
  - `"sequential"`: エージェントが配列順に処理
- `[peerId]`: WhatsAppグループJID、E.164番号、またはその他のピアID
  - 値: メッセージを処理するエージェントIDの配列

## 制限事項

1. **最大エージェント数:** ハードリミットはありませんが、10以上のエージェントは遅くなる可能性があります
2. **共有コンテキスト:** エージェントは互いの応答を見ません（設計上）
3. **メッセージ順序:** パラレル応答は任意の順序で到着する可能性があります
4. **レート制限:** すべてのエージェントがWhatsAppのレート制限にカウントされます

## 今後の拡張予定

計画中の機能:

- [ ] 共有コンテキストモード（エージェントが互いの応答を見る）
- [ ] エージェント連携（エージェントが互いにシグナルを送る）
- [ ] 動的エージェント選択（メッセージ内容に基づいてエージェントを選択）
- [ ] エージェント優先度（一部のエージェントが他より先に応答）

## 関連ドキュメント

- [マルチエージェント設定](/tools/multi-agent-sandbox-tools)
- [ルーティング設定](/channels/channel-routing)
- [セッション管理](/concepts/sessions)
