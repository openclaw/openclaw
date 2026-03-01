---
summary: "リファクタリング計画: exec ホストルーティング、ノード承認、ヘッドレスランナー"
read_when:
  - exec ホストルーティングまたは exec 承認を設計する場合
  - ノードランナー + UI IPC を実装する場合
  - exec ホストセキュリティモードとスラッシュコマンドを追加する場合
title: "Exec ホストリファクタリング"
---

# Exec ホストリファクタリング計画

## 目標

- **sandbox**、**gateway**、**node** 間で実行をルーティングするために `exec.host` + `exec.security` を追加します。
- デフォルトを**安全**に保つ: 明示的に有効化しない限りクロスホスト実行なし。
- オプションの UI（macOS アプリ）をローカル IPC 経由で持つ**ヘッドレスランナーサービス**に実行を分割します。
- **エージェントごとの**ポリシー、アローリスト、ask モード、ノードバインディングを提供します。
- アローリストの_あり/なし_の両方で機能する **ask モード**をサポートします。
- クロスプラットフォーム: Unix ソケット + トークン認証（macOS/Linux/Windows のパリティ）。

## 非目標

- レガシーアローリストの移行やレガシースキーマのサポートなし。
- ノード exec の PTY/ストリーミングなし（集計出力のみ）。
- 既存の Bridge + Gateway を超える新しいネットワークレイヤーなし。

## 決定事項（確定）

- **コンフィグキー:** `exec.host` + `exec.security`（エージェントごとのオーバーライド可能）。
- **昇格:** Gateway への完全アクセスのエイリアスとして `/elevated` を維持。
- **ask デフォルト:** `on-miss`。
- **承認ストア:** `~/.openclaw/exec-approvals.json`（JSON、レガシー移行なし）。
- **ランナー:** ヘッドレスシステムサービス。UI アプリが承認用の Unix ソケットをホスト。
- **ノードアイデンティティ:** 既存の `nodeId` を使用。
- **ソケット認証:** Unix ソケット + トークン（クロスプラットフォーム）。後で必要に応じて分割。
- **ノードホスト状態:** `~/.openclaw/node.json`（ノード ID + ペアリングトークン）。
- **macOS exec ホスト:** macOS アプリ内で `system.run` を実行。ノードホストサービスがローカル IPC でリクエストを転送。
- **XPC ヘルパーなし:** Unix ソケット + トークン + ピアチェックに固執。

## 主要コンセプト

### ホスト

- `sandbox`: Docker exec（現在の動作）。
- `gateway`: Gateway ホストで exec。
- `node`: Bridge 経由でノードランナー上で exec（`system.run`）。

### セキュリティモード

- `deny`: 常にブロック。
- `allowlist`: 一致するもののみ許可。
- `full`: すべてを許可（elevated に相当）。

### Ask モード

- `off`: 決して ask しない。
- `on-miss`: アローリストが一致しない場合のみ ask。
- `always`: 毎回 ask。

Ask はアローリストとは**独立**。アローリストは `always` または `on-miss` と一緒に使用できます。

### ポリシー解決（exec ごと）

1. `exec.host` を解決（ツールパラメータ → エージェントオーバーライド → グローバルデフォルト）。
2. `exec.security` と `exec.ask` を解決（同じ優先順位）。
3. ホストが `sandbox` の場合、ローカルサンドボックス exec を続行。
4. ホストが `gateway` または `node` の場合、そのホストでセキュリティ + ask ポリシーを適用。

## デフォルトの安全性

- デフォルト `exec.host = sandbox`。
- `gateway` と `node` のデフォルト `exec.security = deny`。
- デフォルト `exec.ask = on-miss`（セキュリティが許可する場合にのみ関連）。
- ノードバインディングが設定されていない場合、**エージェントは任意のノードをターゲットにできます**が、ポリシーが許可する場合のみ。

## コンフィグサーフェス

### ツールパラメータ

- `exec.host`（オプション）: `sandbox | gateway | node`。
- `exec.security`（オプション）: `deny | allowlist | full`。
- `exec.ask`（オプション）: `off | on-miss | always`。
- `exec.node`（オプション）: `host=node` の場合に使用するノード ID/名前。

### コンフィグキー（グローバル）

- `tools.exec.host`
- `tools.exec.security`
- `tools.exec.ask`
- `tools.exec.node`（デフォルトノードバインディング）

### コンフィグキー（エージェントごと）

- `agents.list[].tools.exec.host`
- `agents.list[].tools.exec.security`
- `agents.list[].tools.exec.ask`
- `agents.list[].tools.exec.node`

### エイリアス

- `/elevated on` = エージェントセッションの `tools.exec.host=gateway`、`tools.exec.security=full` を設定。
- `/elevated off` = エージェントセッションの以前の exec 設定を復元。

## 承認ストア（JSON）

パス: `~/.openclaw/exec-approvals.json`

目的:

- **実行ホスト**（Gateway またはノードランナー）のローカルポリシー + アローリスト。
- UI が利用できない場合の ask フォールバック。
- UI クライアントの IPC クレデンシャル。

提案するスキーマ（v1）:

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

メモ:

- レガシーアローリストフォーマットなし。
- `askFallback` は `ask` が必要で UI にアクセスできない場合にのみ適用。
- ファイルパーミッション: `0600`。

## ランナーサービス（ヘッドレス）

### ロール

- `exec.security` + `exec.ask` をローカルで強制。
- システムコマンドを実行して出力を返す。
- exec ライフサイクルの Bridge イベントを出力（オプションだが推奨）。

### サービスライフサイクル

- macOS では Launchd/デーモン。Linux/Windows ではシステムサービス。
- 承認 JSON は実行ホストにローカル。
- UI がローカル Unix ソケットをホスト。ランナーはオンデマンドで接続。

## UI 統合（macOS アプリ）

### IPC

- `~/.openclaw/exec-approvals.sock` の Unix ソケット（0600）。
- `exec-approvals.json` に保存されたトークン（0600）。
- ピアチェック: 同一 UID のみ。
- チャレンジ/レスポンス: ノンス + HMAC(token, request-hash) でリプレーを防止。
- 短い TTL（例: 10 秒）+ 最大ペイロード + レート制限。

### Ask フロー（macOS アプリ exec ホスト）

1. ノードサービスが Gateway から `system.run` を受け取る。
2. ノードサービスがローカルソケットに接続し、プロンプト/exec リクエストを送信。
3. アプリがピア + トークン + HMAC + TTL を検証し、必要に応じてダイアログを表示。
4. アプリが UI コンテキストでコマンドを実行し、出力を返す。
5. ノードサービスが出力を Gateway に返す。

UI が欠如している場合:

- `askFallback`（`deny|allowlist|full`）を適用。

### ダイアグラム（SCI）

```
Agent -> Gateway -> Bridge -> Node Service (TS)
                         |  IPC (UDS + token + HMAC + TTL)
                         v
                     Mac App (UI + TCC + system.run)
```

## ノードアイデンティティ + バインディング

- Bridge ペアリングから既存の `nodeId` を使用。
- バインディングモデル:
  - `tools.exec.node` はエージェントを特定のノードに制限。
  - 設定されていない場合、エージェントは任意のノードを選択できる（ポリシーはデフォルトを強制）。
- ノード選択の解決:
  - `nodeId` 完全一致
  - `displayName`（正規化）
  - `remoteIp`
  - `nodeId` プレフィックス（>= 6 文字）

## イベント

### 誰がイベントを見るか

- システムイベントは**セッションごと**で、次のプロンプトでエージェントに表示。
- Gateway のインメモリキューに保存（`enqueueSystemEvent`）。

### イベントテキスト

- `Exec started (node=<id>, id=<runId>)`
- `Exec finished (node=<id>, id=<runId>, code=<code>)` + オプションの出力テール
- `Exec denied (node=<id>, id=<runId>, <reason>)`

### トランスポート

オプション A（推奨）:

- ランナーが `exec.started` / `exec.finished` の Bridge `event` フレームを送信。
- Gateway の `handleBridgeEvent` がこれらを `enqueueSystemEvent` にマッピング。

オプション B:

- Gateway の `exec` ツールがライフサイクルを直接処理（同期のみ）。

## Exec フロー

### サンドボックスホスト

- 既存の `exec` 動作（Docker またはサンドボックス解除時はホスト）。
- PTY は非サンドボックスモードのみサポート。

### Gateway ホスト

- Gateway プロセスが自身のマシンで実行。
- ローカルの `exec-approvals.json`（セキュリティ/ask/アローリスト）を強制。

### ノードホスト

- Gateway が `system.run` で `node.invoke` を呼び出す。
- ランナーがローカル承認を強制。
- ランナーが集計された stdout/stderr を返す。
- 開始/終了/拒否のオプション Bridge イベント。

## 出力キャップ

- 結合された stdout+stderr を **200k** でキャップ。イベント用に **20k のテール**を維持。
- 明確なサフィックスで切り詰め（例: `"… (truncated)"`）。

## スラッシュコマンド

- `/exec host=<sandbox|gateway|node> security=<deny|allowlist|full> ask=<off|on-miss|always> node=<id>`
- エージェントごと、セッションごとのオーバーライド。コンフィグ経由で保存しない限り永続化なし。
- `/elevated on|off|ask|full` は `host=gateway security=full` のショートカットとして維持（`full` は承認をスキップ）。

## クロスプラットフォームの話

- ランナーサービスがポータブルな実行ターゲット。
- UI はオプション。欠如している場合、`askFallback` が適用。
- Windows/Linux は同じ承認 JSON + ソケットプロトコルをサポート。

## 実装フェーズ

### フェーズ 1: コンフィグ + exec ルーティング

- `exec.host`、`exec.security`、`exec.ask`、`exec.node` のコンフィグスキーマを追加。
- `exec.host` を尊重するようにツールの配管を更新。
- `/exec` スラッシュコマンドを追加し、`/elevated` エイリアスを維持。

### フェーズ 2: 承認ストア + Gateway 強制

- `exec-approvals.json` のリーダー/ライターを実装。
- `gateway` ホストのアローリスト + ask モードを強制。
- 出力キャップを追加。

### フェーズ 3: ノードランナーの強制

- アローリスト + ask を強制するようにノードランナーを更新。
- macOS アプリ UI に Unix ソケットプロンプトブリッジを追加。
- `askFallback` を配線。

### フェーズ 4: イベント

- exec ライフサイクルのノード → Gateway Bridge イベントを追加。
- エージェントプロンプトのために `enqueueSystemEvent` にマッピング。

### フェーズ 5: UI ポリッシュ

- Mac アプリ: アローリストエディター、エージェントごとのスイッチャー、ask ポリシー UI。
- ノードバインディングコントロール（オプション）。

## テスト計画

- ユニットテスト: アローリストマッチング（glob + 大文字小文字を区別しない）。
- ユニットテスト: ポリシー解決の優先順位（ツールパラメータ → エージェントオーバーライド → グローバル）。
- 統合テスト: ノードランナーの deny/allow/ask フロー。
- Bridge イベントテスト: ノードイベント → システムイベントルーティング。

## オープンリスク

- UI の利用不可: `askFallback` が尊重されることを確認。
- 長時間実行コマンド: タイムアウト + 出力キャップに依存。
- マルチノードの曖昧さ: ノードバインディングまたは明示的なノードパラメータがない限りエラー。

## 関連ドキュメント

- [Exec ツール](/tools/exec)
- [Exec 承認](/tools/exec-approvals)
- [ノード](/nodes)
- [Elevated モード](/tools/elevated)
