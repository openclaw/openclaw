---
title: 形式検証（セキュリティモデル）
summary: OpenClaw の最高リスク経路に対する、機械検証されたセキュリティモデル。
permalink: /security/formal-verification/
x-i18n:
  source_path: security/formal-verification.md
  source_hash: 8dff6ea41a37fb6b
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:23:22Z
---

# 形式検証（セキュリティモデル）

このページでは、OpenClaw の **形式的セキュリティモデル**（現在は TLA+/TLC、必要に応じて追加）を追跡します。

> 注記: 一部の古いリンクは、以前のプロジェクト名を参照している場合があります。

**目標（北極星）:** 明示的な前提の下で、OpenClaw が意図したセキュリティポリシー（認可、セッション分離、ツールのゲーティング、誤設定に対する安全性）を強制していることを、機械検証された形で示すことです。

**これは何か（現時点）:** 実行可能で、攻撃者主導の **セキュリティ回帰スイート** です。

- 各主張には、有限状態空間に対する実行可能なモデル検査があります。
- 多くの主張には、現実的なバグクラスに対する反例トレースを生成する **ネガティブモデル** が対になっています。

**これは何ではないか（まだ）:** 「OpenClaw があらゆる点で安全である」こと、または TypeScript 実装全体が正しいことの証明ではありません。

## モデルの所在

モデルは別リポジトリで管理されています: [vignesh07/openclaw-formal-models](https://github.com/vignesh07/openclaw-formal-models)。

## 重要な注意事項

- これらは **モデル** であり、完全な TypeScript 実装ではありません。モデルとコードの乖離が生じる可能性があります。
- 結果は TLC が探索する状態空間に制約されます。「グリーン」は、モデル化された前提や境界を超えた安全性を意味しません。
- 一部の主張は、明示的な環境前提（例: 正しいデプロイ、正しい設定入力）に依存します。

## 結果の再現

現在、モデルのリポジトリをローカルにクローンし、TLC を実行することで結果を再現します（下記参照）。将来のイテレーションでは、次の提供が考えられます。

- 公開アーティファクト（反例トレース、実行ログ）を伴う CI 実行モデル
- 小規模で境界付きのチェック向けの「このモデルを実行」するホスト型ワークフロー

はじめに:

```bash
git clone https://github.com/vignesh07/openclaw-formal-models
cd openclaw-formal-models

# Java 11+ required (TLC runs on the JVM).
# The repo vendors a pinned `tla2tools.jar` (TLA+ tools) and provides `bin/tlc` + Make targets.

make <target>
```

### Gateway の公開とオープンゲートウェイの誤設定

**主張:** 認証なしで loopback を超えてバインドすると、リモート侵害が可能になる／露出が増大します。トークン／パスワードは、モデル前提の下で未認証の攻撃者をブロックします。

- グリーン実行:
  - `make gateway-exposure-v2`
  - `make gateway-exposure-v2-protected`
- レッド（想定どおり）:
  - `make gateway-exposure-v2-negative`

モデルリポジトリ内の `docs/gateway-exposure-matrix.md` も参照してください。

### Nodes.run パイプライン（最高リスク能力）

**主張:** `nodes.run` には、（a）ノードコマンドの許可リストと宣言済みコマンド、（b）設定時のライブ承認が必要です。承認は（モデル内で）リプレイ防止のためにトークン化されています。

- グリーン実行:
  - `make nodes-pipeline`
  - `make approvals-token`
- レッド（想定どおり）:
  - `make nodes-pipeline-negative`
  - `make approvals-token-negative`

### ペアリングストア（DM ゲーティング）

**主張:** ペアリング要求は TTL と保留中要求数の上限を尊重します。

- グリーン実行:
  - `make pairing`
  - `make pairing-cap`
- レッド（想定どおり）:
  - `make pairing-negative`
  - `make pairing-cap-negative`

### 受信ゲーティング（メンション + 制御コマンドのバイパス）

**主張:** メンションを要求するグループコンテキストにおいて、未認可の「制御コマンド」はメンションゲーティングをバイパスできません。

- グリーン:
  - `make ingress-gating`
- レッド（想定どおり）:
  - `make ingress-gating-negative`

### ルーティング／セッションキー分離

**主張:** 明示的にリンク／設定されない限り、異なるピアからの DM は同一セッションに統合されません。

- グリーン:
  - `make routing-isolation`
- レッド（想定どおり）:
  - `make routing-isolation-negative`

## v1++: 追加の境界付きモデル（並行性、リトライ、トレースの正確性）

これらは、実世界の障害モード（非原子的更新、リトライ、メッセージのファンアウト）に関する忠実度を高める後続モデルです。

### ペアリングストアの並行性／冪等性

**主張:** ペアリングストアは、インターリーブ下でも `MaxPending` と冪等性を強制すべきです（すなわち「チェックしてから書く」は原子的／ロックされていなければならず、更新は重複を作ってはなりません）。

意味するところ:

- 並行リクエスト下でも、チャンネルあたりの `MaxPending` を超えられません。
- 同一の `(channel, sender)` に対する繰り返しのリクエスト／更新で、重複した有効な保留行を作成してはなりません。

- グリーン実行:
  - `make pairing-race`（原子的／ロックされた上限チェック）
  - `make pairing-idempotency`
  - `make pairing-refresh`
  - `make pairing-refresh-race`
- レッド（想定どおり）:
  - `make pairing-race-negative`（非原子的 begin/commit による上限競合）
  - `make pairing-idempotency-negative`
  - `make pairing-refresh-negative`
  - `make pairing-refresh-race-negative`

### 受信トレースの相関／冪等性

**主張:** 取り込みは、ファンアウト全体でトレース相関を保持し、プロバイダーのリトライ下でも冪等であるべきです。

意味するところ:

- 1 つの外部イベントが複数の内部メッセージになる場合、すべての要素が同一のトレース／イベント ID を保持します。
- リトライによって二重処理が発生しません。
- プロバイダーのイベント ID が欠落している場合、重複排除は安全なキー（例: トレース ID）にフォールバックし、異なるイベントの取りこぼしを防ぎます。

- グリーン:
  - `make ingress-trace`
  - `make ingress-trace2`
  - `make ingress-idempotency`
  - `make ingress-dedupe-fallback`
- レッド（想定どおり）:
  - `make ingress-trace-negative`
  - `make ingress-trace2-negative`
  - `make ingress-idempotency-negative`
  - `make ingress-dedupe-fallback-negative`

### ルーティングの dmScope 優先順位 + identityLinks

**主張:** ルーティングは、既定で DM セッションを分離し、明示的に設定された場合にのみセッションを統合しなければなりません（チャンネル優先順位 + identity links）。

意味するところ:

- チャンネル固有の dmScope 上書きは、グローバル既定より優先されなければなりません。
- identityLinks は、無関係なピア間ではなく、明示的にリンクされたグループ内でのみ統合すべきです。

- グリーン:
  - `make routing-precedence`
  - `make routing-identitylinks`
- レッド（想定どおり）:
  - `make routing-precedence-negative`
  - `make routing-identitylinks-negative`
