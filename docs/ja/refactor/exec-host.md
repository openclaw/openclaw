---
summary: "リファクタリング計画：exec ホストのルーティング、ノード承認、ヘッドレスランナー"
read_when:
  - exec ホストのルーティングまたは exec 承認を設計しているとき
  - ノードランナー + UI IPC を実装するとき
  - exec ホストのセキュリティモードおよびスラッシュコマンドを追加するとき
title: "Exec ホストのリファクタリング"
---

# Exec ホストのリファクタリング計画

## 目標

- **sandbox**、**gateway**、**node** 間で実行をルーティングするために `exec.host` + `exec.security` を追加します。
- デフォルトを **安全** に保ち、明示的に有効化されない限りクロスホスト実行を行いません。
- 実行を **ヘッドレスランナーサービス** に分離し、ローカル IPC 経由のオプション UI（macOS アプリ）を提供します。
- **エージェントごと** のポリシー、許可リスト、確認モード、ノードバインディングを提供します。
- 許可リストの _有無_ にかかわらず動作する **確認モード** をサポートします。
- クロスプラットフォーム：Unix ソケット + トークン認証（macOS/Linux/Windows の同等性）。

## 非目標

- レガシー許可リストの移行やレガシースキーマのサポートは行いません。
- ノード exec における PTY/ストリーミングは行いません（集約された出力のみ）。
- 既存の Bridge + Gateway 以外の新しいネットワークレイヤーは追加しません。

## 決定事項（確定）

- **設定キー：** `exec.host` + `exec.security`（エージェントごとの上書きを許可）。
- **昇格：** `/elevated` を gateway のフルアクセスのエイリアスとして維持します。
- **確認のデフォルト：** `on-miss`。
- **承認ストア：** `~/.openclaw/exec-approvals.json`（JSON、レガシー移行なし）。
- **ランナー：** ヘッドレスのシステムサービス。UI アプリは承認用の Unix ソケットをホストします。
- **ノード ID：** 既存の `nodeId` を使用します。
- **ソケット認証：** Unix ソケット + トークン（クロスプラットフォーム）。必要に応じて後で分割します。
- **ノードホスト状態：** `~/.openclaw/node.json`（ノード ID + ペアリングトークン）。
- **macOS exec ホスト：** macOS アプリ内で `system.run` を実行し、ノードホストサービスはローカル IPC 経由でリクエストを転送します。
- **XPC ヘルパーなし：** Unix ソケット + トークン + ピアチェックを使用します。

## 主要概念

### ホスト

- `sandbox`：Docker exec（現在の挙動）。
- `gateway`：ゲートウェイホスト上での exec。
- `node`：Bridge（`system.run`）経由でノードランナー上の exec。

### セキュリティモード

- `deny`：常にブロックします。
- `allowlist`：一致するもののみ許可します。
- `full`：すべて許可します（昇格と同等）。

### 確認モード

- `off`: 決して聞かない。
- `on-miss`：許可リストに一致しない場合のみ確認します。
- `always`：毎回確認します。

確認は許可リストと **独立** しています。許可リストは `always` または `on-miss` と併用できます。

### ポリシー解決（exec ごと）

1. `exec.host` を解決します（ツール引数 → エージェント上書き → グローバルデフォルト）。
2. `exec.security` と `exec.ask` を解決します（同じ優先順位）。
3. ホストが `sandbox` の場合、ローカルサンドボックス exec を実行します。
4. ホストが `gateway` または `node` の場合、そのホストでセキュリティ + 確認ポリシーを適用します。

## デフォルトの安全性

- デフォルトは `exec.host = sandbox`。
- `gateway` および `node` のデフォルトは `exec.security = deny`。
- デフォルトは `exec.ask = on-miss`（セキュリティが許可する場合のみ関連）。
- ノードバインディングが設定されていない場合、**エージェントは任意のノードを対象にできます** が、ポリシーが許可する場合に限ります。

## 設定サーフェス

### ツール引数

- `exec.host`（任意）：`sandbox | gateway | node`。
- `exec.security`（任意）：`deny | allowlist | full`。
- `exec.ask`（任意）：`off | on-miss | always`。
- `exec.node`（任意）：`host=node` の場合に使用するノード ID/名前。

### 設定キー（グローバル）

- `tools.exec.host`
- `tools.exec.security`
- `tools.exec.ask`
- `tools.exec.node`（デフォルトのノードバインディング）

### 設定キー（エージェントごと）

- `agents.list[].tools.exec.host`
- `agents.list[].tools.exec.security`
- `agents.list[].tools.exec.ask`
- `agents.list[].tools.exec.node`

### エイリアス

- `/elevated on`：エージェントセッションに対して `tools.exec.host=gateway`、`tools.exec.security=full` を設定します。
- `/elevated off`：エージェントセッションの以前の exec 設定を復元します。

## 承認ストア（JSON）

パス：`~/.openclaw/exec-approvals.json`

目的：

- **実行ホスト**（gateway またはノードランナー）のローカルポリシー + 許可リスト。
- UI が利用できない場合の確認フォールバック。
- UI クライアント用の IPC 資格情報。

提案スキーマ（v1）：

```json
{
  "version": 1,
  "socket": {
    "path": "~/.openclaw/exec-approvals.sock",
    "token": "base64-opaque-token"
  },
  "defaults": {
    "security": "deny",
    "ask": "on-miss",
    "askFallback": "deny"
  },
  "agents": {
    "agent-id-1": {
      "security": "allowlist",
      "ask": "on-miss",
      "allowlist": [
        {
          "pattern": "~/Projects/**/bin/rg",
          "lastUsedAt": 0,
          "lastUsedCommand": "rg -n TODO",
          "lastResolvedPath": "/Users/user/Projects/.../bin/rg"
        }
      ]
    }
  }
}
```

注記：

- レガシー許可リスト形式はありません。
- `askFallback` は、`ask` が必要で UI に到達できない場合にのみ適用されます。
- ファイル権限：`0600`。

## ランナーサービス（ヘッドレス）

### 役割

- ローカルで `exec.security` + `exec.ask` を強制します。
- システムコマンドを実行し、出力を返します。
- exec ライフサイクルの Bridge イベントを送出します（任意ですが推奨）。

### サービスライフサイクル

- macOS では launchd/デーモン、Linux/Windows ではシステムサービス。
- 承認 JSON は実行ホストにローカルです。
- UI はローカル Unix ソケットをホストし、ランナーはオンデマンドで接続します。

## UI 連携（macOS アプリ）

### IPC

- Unix ソケット：`~/.openclaw/exec-approvals.sock`（0600）。
- トークン保存先：`exec-approvals.json`（0600）。
- ピアチェック：同一 UID のみ。
- チャレンジ/レスポンス：リプレイ防止のため、nonce + HMAC(token, request-hash)。
- 短い TTL（例：10 秒）+ 最大ペイロード + レート制限。

### 確認フロー（macOS アプリ exec ホスト）

1. ノードサービスが gateway から `system.run` を受信します。
2. ノードサービスがローカルソケットに接続し、プロンプト/exec リクエストを送信します。
3. アプリがピア + トークン + HMAC + TTL を検証し、必要に応じてダイアログを表示します。
4. アプリが UI コンテキストでコマンドを実行し、出力を返します。
5. ノードサービスが出力を gateway に返します。

UI が存在しない場合：

- `askFallback`（`deny|allowlist|full`）を適用します。

### 図（SCI）

```
Agent -> Gateway -> Bridge -> Node Service (TS)
                         |  IPC (UDS + token + HMAC + TTL)
                         v
                     Mac App (UI + TCC + system.run)
```

## ノード ID + バインディング

- Bridge ペアリングの既存 `nodeId` を使用します。
- バインディングモデル：
  - `tools.exec.node` はエージェントを特定のノードに制限します。
  - 未設定の場合、エージェントは任意のノードを選択できます（ポリシーは引き続きデフォルトを強制）。
- ノード選択の解決順：
  - `nodeId` の完全一致
  - `displayName`（正規化）
  - `remoteIp`
  - `nodeId` のプレフィックス（6 文字以上）

## イベント

### イベントを閲覧する人

- システムイベントは **セッション単位** で、次のプロンプト時にエージェントへ表示されます。
- gateway のインメモリキュー（`enqueueSystemEvent`）に保存されます。

### イベント文言

- `Exec started (node=<id>, id=<runId>)`
- `Exec finished (node=<id>, id=<runId>, code=<code>)` + 任意の出力末尾
- `Exec denied (node=<id>, id=<runId>, <reason>)`

### 伝送

オプション A（推奨）：

- ランナーが Bridge の `event` フレーム `exec.started` / `exec.finished` を送信します。
- gateway がこれらを `enqueueSystemEvent` にマッピングします（`handleBridgeEvent`）。

オプション B：

- gateway の `exec` ツールがライフサイクルを直接処理します（同期のみ）。

## Exec フロー

### サンドボックスホスト

- 既存の `exec` の挙動（Docker、または非サンドボックス時はホスト）。
- PTY は非サンドボックスモードでのみサポートされます。

### ゲートウェイホスト

- Gateway プロセスが自身のマシン上で実行されます。
- ローカルの `exec-approvals.json`（セキュリティ/確認/許可リスト）を強制します。

### ノードホスト

- Gateway が `system.run` を指定して `node.invoke` を呼び出します。
- ランナーがローカル承認を強制します。
- ランナーが集約された stdout/stderr を返します。
- 開始/終了/拒否の Bridge イベントは任意です。

## 出力上限

- stdout+stderr の合計を **200k** に制限し、イベント用に **末尾 20k** を保持します。
- 明確なサフィックス（例：`"… (truncated)"`）を付けて切り詰めます。

## スラッシュコマンド

- `/exec host=<sandbox|gateway|node> security=<deny|allowlist|full> ask=<off|on-miss|always> node=<id>`
- エージェントごと、セッションごとの上書き。設定で保存しない限り永続化されません。
- `/elevated on|off|ask|full` は `host=gateway security=full` のショートカットとして残します（`full` により承認をスキップ）。

## クロスプラットフォーム対応

- ランナーサービスが移植可能な実行ターゲットです。
- UI は任意であり、存在しない場合は `askFallback` が適用されます。
- Windows/Linux は同一の承認 JSON + ソケットプロトコルをサポートします。

## 実装フェーズ

### フェーズ 1：設定 + exec ルーティング

- `exec.host`、`exec.security`、`exec.ask`、`exec.node` の設定スキーマを追加します。
- `exec.host` を尊重するようツールの配線を更新します。
- `/exec` のスラッシュコマンドを追加し、`/elevated` のエイリアスを維持します。

### フェーズ 2：承認ストア + gateway 強制

- `exec-approvals.json` のリーダー/ライターを実装します。
- `gateway` ホストに対して許可リスト + 確認モードを強制します。
- 出力上限を追加します。

### フェーズ 3：ノードランナー強制

- ノードランナーを更新し、許可リスト + 確認を強制します。
- macOS アプリ UI への Unix ソケットプロンプトブリッジを追加します。
- `askFallback` を接続します。

### フェーズ 4：イベント

- exec ライフサイクルのノード → gateway Bridge イベントを追加します。
- エージェントのプロンプト用に `enqueueSystemEvent` へマッピングします。

### フェーズ 5：UI の仕上げ

- Mac アプリ：許可リストエディター、エージェントごとの切り替え、確認ポリシー UI。
- ノードバインディング制御（任意）。

## テスト計画

- ユニットテスト：許可リスト一致（glob + 大文字小文字非依存）。
- ユニットテスト：ポリシー解決の優先順位（ツール引数 → エージェント上書き → グローバル）。
- 統合テスト：ノードランナーの拒否/許可/確認フロー。
- Bridge イベントテスト：ノードイベント → システムイベントのルーティング。

## オープンなリスク

- UI の利用不可：`askFallback` が遵守されることを保証します。
- 長時間実行コマンド：タイムアウト + 出力上限に依存します。
- マルチノードの曖昧性：ノードバインディングまたは明示的なノード引数がない場合はエラーとします。

## 関連ドキュメント

- [Exec ツール](/tools/exec)
- [Exec 承認](/tools/exec-approvals)
- [ノード](/nodes)
- [昇格モード](/tools/elevated)
