---
title: 形式検証（セキュリティモデル）
summary: OpenClaw の最もリスクの高いパスに対する機械検証済みのセキュリティモデル。
read_when:
  - 形式セキュリティモデルの保証や制限をレビューする場合
  - TLA+/TLC セキュリティモデルチェックを再現または更新する場合
permalink: /security/formal-verification/
---

# 形式検証（セキュリティモデル）

このページでは、OpenClaw の**形式セキュリティモデル**（現在は TLA+/TLC; 必要に応じて追加）を追跡します。

> 注意: 一部の古いリンクは以前のプロジェクト名を参照している場合があります。

**目標（北極星）:** 明示的な仮定の下で、OpenClaw が意図したセキュリティポリシー（認可、セッション分離、ツールゲーティング、設定ミスの安全性）を強制することを、機械検証された論拠で示すことです。

**現状（今日）:** 実行可能な、攻撃者駆動型の**セキュリティリグレッションスイート**:

- 各クレームは有限状態空間上で実行可能なモデルチェックを持ちます。
- 多くのクレームには、現実的なバグクラスの反例トレースを生成する、対になる**ネガティブモデル**があります。

**現時点でないもの:** 「OpenClaw はすべての点で安全である」または完全な TypeScript 実装が正しいことの証明ではありません。

## モデルの場所

モデルは別のリポジトリで管理されています: [vignesh07/openclaw-formal-models](https://github.com/vignesh07/openclaw-formal-models)

## 重要な注意事項

- これらは**モデル**であり、完全な TypeScript 実装ではありません。モデルとコードの間にずれが生じる可能性があります。
- 結果は TLC が探索する状態空間に制限されます。「グリーン」はモデル化された仮定と境界を超えたセキュリティを意味しません。
- 一部のクレームは明示的な環境の仮定に依存しています（例: 正しいデプロイ、正しい設定入力）。

## 結果の再現

現在、結果はモデルリポジトリをローカルにクローンして TLC を実行することで再現されます（以下を参照）。将来のイテレーションでは以下が提供される可能性があります。

- パブリックアーティファクト付きの CI 実行モデル（反例トレース、実行ログ）
- 小さな境界付きチェックのための「このモデルを実行する」ホストワークフロー

始め方:

```bash
git clone https://github.com/vignesh07/openclaw-formal-models
cd openclaw-formal-models

# Java 11+ が必要（TLC は JVM 上で動作）。
# リポジトリはピン留めされた `tla2tools.jar`（TLA+ ツール）を同梱し、`bin/tlc` + Make ターゲットを提供します。

make <target>
```

### Gateway の露出とオープン Gateway の設定ミス

**クレーム:** 認証なしでループバックを超えてバインドすると、リモートの侵害が可能になる/露出が増加します。トークン/パスワードは（モデルの仮定の範囲内で）未認証の攻撃者をブロックします。

- グリーン実行:
  - `make gateway-exposure-v2`
  - `make gateway-exposure-v2-protected`
- レッド（期待される）:
  - `make gateway-exposure-v2-negative`

モデルリポジトリの `docs/gateway-exposure-matrix.md` も参照してください。

### Nodes.run パイプライン（最高リスクの機能）

**クレーム:** `nodes.run` は (a) ノードコマンドの許可リストと宣言されたコマンド、および (b) 設定された場合のライブ承認を必要とします。承認はリプレイを防ぐためにトークン化されています（モデル内）。

- グリーン実行:
  - `make nodes-pipeline`
  - `make approvals-token`
- レッド（期待される）:
  - `make nodes-pipeline-negative`
  - `make approvals-token-negative`

### ペアリングストア（DM ゲーティング）

**クレーム:** ペアリングリクエストは TTL と保留リクエストの上限を尊重します。

- グリーン実行:
  - `make pairing`
  - `make pairing-cap`
- レッド（期待される）:
  - `make pairing-negative`
  - `make pairing-cap-negative`

### イングレスゲーティング（メンション + コントロールコマンドバイパス）

**クレーム:** メンションを必要とするグループコンテキストにおいて、未認証の「コントロールコマンド」はメンションゲーティングをバイパスできません。

- グリーン:
  - `make ingress-gating`
- レッド（期待される）:
  - `make ingress-gating-negative`

### ルーティング/セッションキーの分離

**クレーム:** 異なるピアからの DM は、明示的にリンク/設定されない限り、同じセッションに統合されません。

- グリーン:
  - `make routing-isolation`
- レッド（期待される）:
  - `make routing-isolation-negative`

## v1++: 追加の境界付きモデル（並行性、リトライ、トレースの正確性）

これらは実世界の障害モード（非アトミックな更新、リトライ、メッセージのファンアウト）に関する忠実度を高めるフォローアップモデルです。

### ペアリングストアの並行性 / 冪等性

**クレーム:** ペアリングストアはインターリービング下でも `MaxPending` と冪等性を強制する必要があります（つまり、「チェックしてから書き込む」はアトミック/ロックされている必要があります。リフレッシュで重複を作成してはなりません）。

意味するところ:

- 並行リクエスト下でも、チャンネルの `MaxPending` を超えることはできません。
- 同じ `(channel, sender)` に対する繰り返しのリクエスト/リフレッシュは、重複したライブ保留行を作成してはなりません。

- グリーン実行:
  - `make pairing-race`（アトミック/ロックされた上限チェック）
  - `make pairing-idempotency`
  - `make pairing-refresh`
  - `make pairing-refresh-race`
- レッド（期待される）:
  - `make pairing-race-negative`（非アトミックな begin/commit 上限レース）
  - `make pairing-idempotency-negative`
  - `make pairing-refresh-negative`
  - `make pairing-refresh-race-negative`

### イングレストレース相関 / 冪等性

**クレーム:** インジェスションはファンアウト全体でトレース相関を保持し、プロバイダーのリトライ下でも冪等である必要があります。

意味するところ:

- 1 つの外部イベントが複数の内部メッセージになる場合、すべての部分が同じトレース/イベントアイデンティティを保持します。
- リトライは二重処理を引き起こしません。
- プロバイダーのイベント ID が欠けている場合、重複排除は安全なキー（例: トレース ID）にフォールバックし、個別のイベントの欠落を防ぎます。

- グリーン:
  - `make ingress-trace`
  - `make ingress-trace2`
  - `make ingress-idempotency`
  - `make ingress-dedupe-fallback`
- レッド（期待される）:
  - `make ingress-trace-negative`
  - `make ingress-trace2-negative`
  - `make ingress-idempotency-negative`
  - `make ingress-dedupe-fallback-negative`

### ルーティング dmScope の優先順位 + identityLinks

**クレーム:** ルーティングはデフォルトで DM セッションを分離したままにし、明示的に設定された場合のみセッションを統合する必要があります（チャンネルの優先順位 + アイデンティティリンク）。

意味するところ:

- チャンネル固有の dmScope オーバーライドはグローバルのデフォルトより優先される必要があります。
- identityLinks は、明示的にリンクされたグループ内のみで統合し、無関係なピア間では統合しないようにする必要があります。

- グリーン:
  - `make routing-precedence`
  - `make routing-identitylinks`
- レッド（期待される）:
  - `make routing-precedence-negative`
  - `make routing-identitylinks-negative`
