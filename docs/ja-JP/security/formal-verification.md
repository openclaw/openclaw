---
permalink: /security/formal-verification/
read_when:
    - 形式的セキュリティモデルの保証や制限をレビューする場合
    - TLA+/TLC セキュリティモデルチェックの再現や更新を行う場合
summary: OpenClaw の最もリスクの高いパスに対する機械検証済みセキュリティモデル。
title: 形式検証（セキュリティモデル）
x-i18n:
    generated_at: "2026-04-02T07:54:38Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: 0f7cd2461dcc00d320a5210e50279d76a7fa84e0830c440398323d75e262a38a
    source_path: security/formal-verification.md
    workflow: 15
---

# 形式検証（セキュリティモデル）

このページでは OpenClaw の**形式的セキュリティモデル**（現在は TLA+/TLC、必要に応じて追加）を追跡しています。

> 注意: 古いリンクの一部は以前のプロジェクト名を参照している場合があります。

**目標（北極星）：** OpenClaw が意図したセキュリティポリシー（認可、セッション分離、ツールゲーティング、設定ミスに対する安全性）を、明示的な前提条件のもとで実施していることを、機械検証された論証として提供すること。

**現在の状態：** 実行可能な、攻撃者駆動の**セキュリティ回帰テストスイート**：

- 各主張には、有限状態空間に対する実行可能なモデルチェックがあります。
- 多くの主張には、現実的なバグクラスに対する反例トレースを生成する**ネガティブモデル**が対になっています。

**まだ実現していないこと：**「OpenClaw がすべての側面で安全である」という証明や、TypeScript 実装全体が正しいという証明。

## モデルの場所

モデルは別のリポジトリで管理されています: [vignesh07/openclaw-formal-models](https://github.com/vignesh07/openclaw-formal-models)。

## 重要な注意事項

- これらは**モデル**であり、完全な TypeScript 実装ではありません。モデルとコードの間にずれが生じる可能性があります。
- 結果は TLC が探索した状態空間に制約されます。「グリーン」はモデル化された前提条件と境界を超えたセキュリティを保証するものではありません。
- 一部の主張は、明示的な環境前提条件（正しいデプロイメント、正しい設定入力など）に依存しています。

## 結果の再現

現在、結果はモデルリポジトリをローカルにクローンし、TLC を実行することで再現できます（以下を参照）。将来のイテレーションでは以下を提供する可能性があります：

- パブリックアーティファクト（反例トレース、実行ログ）を含む CI 実行モデル
- 小規模で境界が定められたチェック用の「このモデルを実行」ワークフローのホスティング

はじめに：

```bash
git clone https://github.com/vignesh07/openclaw-formal-models
cd openclaw-formal-models

# Java 11+ が必要（TLC は JVM 上で動作します）。
# リポジトリにはピン留めされた `tla2tools.jar`（TLA+ ツール）が同梱されており、`bin/tlc` と Make ターゲットが提供されます。

make <target>
```

### Gateway ゲートウェイの公開とオープン Gateway ゲートウェイの設定ミス

**主張：** 認証なしで loopback 以外にバインドすると、リモート侵害が可能になる / 露出が増大する。トークン/パスワードは未認証の攻撃者をブロックする（モデルの前提条件において）。

- グリーン実行：
  - `make gateway-exposure-v2`
  - `make gateway-exposure-v2-protected`
- レッド（想定通り）：
  - `make gateway-exposure-v2-negative`

モデルリポジトリ内の `docs/gateway-exposure-matrix.md` も参照してください。

### ノード実行パイプライン（最もリスクの高い機能）

**主張：** `exec host=node` には (a) ノードコマンド許可リストと宣言されたコマンド、および (b) 設定時のライブ承認が必要。承認はリプレイを防ぐためにトークン化される（モデル内）。

- グリーン実行：
  - `make nodes-pipeline`
  - `make approvals-token`
- レッド（想定通り）：
  - `make nodes-pipeline-negative`
  - `make approvals-token-negative`

### ペアリングストア（ダイレクトメッセージゲーティング）

**主張：** ペアリングリクエストは TTL と保留リクエストの上限を遵守する。

- グリーン実行：
  - `make pairing`
  - `make pairing-cap`
- レッド（想定通り）：
  - `make pairing-negative`
  - `make pairing-cap-negative`

### イングレスゲーティング（メンション + 制御コマンドバイパス）

**主張：** メンションが必要なグループコンテキストにおいて、未認可の「制御コマンド」はメンションゲーティングをバイパスできない。

- グリーン：
  - `make ingress-gating`
- レッド（想定通り）：
  - `make ingress-gating-negative`

### ルーティング/セッションキー分離

**主張：** 異なるピアからのダイレクトメッセージは、明示的にリンク/設定されない限り、同一セッションに統合されない。

- グリーン：
  - `make routing-isolation`
- レッド（想定通り）：
  - `make routing-isolation-negative`

## v1++: 追加の有限モデル（並行性、リトライ、トレースの正確性）

これらは、実際の障害モード（非アトミック更新、リトライ、メッセージファンアウト）に関する忠実度を高めるフォローアップモデルです。

### ペアリングストアの並行性 / 冪等性

**主張：** ペアリングストアはインターリーブ下でも `MaxPending` と冪等性を実施する必要がある（つまり「チェックしてから書き込む」操作はアトミック/ロック付きでなければならない。リフレッシュは重複を生成してはならない）。

意味：

- 並行リクエスト下で、チャネルの `MaxPending` を超えることはできない。
- 同じ `(channel, sender)` に対する繰り返しリクエスト/リフレッシュは、重複するライブ保留行を作成してはならない。

- グリーン実行：
  - `make pairing-race`（アトミック/ロック付き上限チェック）
  - `make pairing-idempotency`
  - `make pairing-refresh`
  - `make pairing-refresh-race`
- レッド（想定通り）：
  - `make pairing-race-negative`（非アトミック begin/commit 上限競合）
  - `make pairing-idempotency-negative`
  - `make pairing-refresh-negative`
  - `make pairing-refresh-race-negative`

### イングレストレース相関 / 冪等性

**主張：** インジェスチョンはファンアウト全体でトレース相関を保持し、プロバイダーリトライ下で冪等でなければならない。

意味：

- 1つの外部イベントが複数の内部メッセージになる場合、すべての部分が同じトレース/イベント ID を保持する。
- リトライによって二重処理が発生してはならない。
- プロバイダーイベント ID が存在しない場合、重複排除は安全なキー（トレース ID など）にフォールバックし、異なるイベントの削除を回避する。

- グリーン：
  - `make ingress-trace`
  - `make ingress-trace2`
  - `make ingress-idempotency`
  - `make ingress-dedupe-fallback`
- レッド（想定通り）：
  - `make ingress-trace-negative`
  - `make ingress-trace2-negative`
  - `make ingress-idempotency-negative`
  - `make ingress-dedupe-fallback-negative`

### ルーティング dmScope 優先順位 + identityLinks

**主張：** ルーティングはデフォルトでダイレクトメッセージセッションを分離し、明示的に設定された場合のみセッションを統合する必要がある（チャネル優先順位 + identityLinks）。

意味：

- チャネル固有の dmScope オーバーライドはグローバルデフォルトに優先しなければならない。
- identityLinks は明示的にリンクされたグループ内でのみ統合し、無関係なピア間では統合してはならない。

- グリーン：
  - `make routing-precedence`
  - `make routing-identitylinks`
- レッド（想定通り）：
  - `make routing-precedence-negative`
  - `make routing-identitylinks-negative`
