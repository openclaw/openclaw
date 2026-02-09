---
summary: "cron.add の入力処理を強化し、スキーマを整合させ、cron の UI／エージェント向けツールを改善します"
owner: "openclaw"
status: "complete"
last_updated: "2026-01-05"
title: "Cron Add のハードニング"
---

# Cron Add のハードニング & スキーマ整合

## Context

最近のゲートウェイログでは、無効なパラメータで繰り返された `cron.add` 失敗が表示されます。(`sessionTarget` 、 `wakeMode` 、 `payload` 、 `schedule` がありません)。 これは、少なくとも1つのクライアント (エージェントツールコールパス) がラップされたジョブペイロードまたは部分的に指定されたジョブペイロードを送信している可能性があります。 それとは別に、TypeScript、ゲートウェイスキーマ、CLIフラグ、UIフォームタイプのcronプロバイダ列挙に加え、`cronのUI不一致があります。 tatus` (ゲートウェイは `jobs` を返し、`jobCount` を期待しています)。

## Goals

- 一般的な ラッパー ペイロードを正規化し、不足している `kind` フィールドを推論することで、`cron.add` INVALID_REQUEST のスパムを停止します。
- ゲートウェイ のスキーマ、cron 型、CLI ドキュメント、UI フォーム全体で cron プロバイダー の一覧を整合させます。
- LLM が正しい ジョブ ペイロードを生成できるよう、エージェント の cron ツール スキーマを明示的にします。
- Control UI の cron ステータスにおける ジョブ 件数表示を修正します。
- 正規化と ツール の挙動をカバーするテストを追加します。

## Non-goals

- cron のスケジューリング セマンティクスや ジョブ 実行の挙動を変更しません。
- 新しい スケジュール 種別や cron 式のパースを追加しません。
- 必要な フィールド 修正を超えて、cron の UI／UX を全面的に刷新しません。

## Findings（current gaps）

- ゲートウェイ の `CronPayloadSchema` は `signal` + `imessage` を除外していますが、TS 型には含まれています。
- Control UI の CronStatus は `jobCount` を期待しますが、ゲートウェイ は `jobs` を返します。
- エージェント の cron ツール スキーマは任意の `job` オブジェクトを許可しており、不正な入力を可能にしています。
- ゲートウェイ は 正規化 なしで `cron.add` を厳格に検証するため、ラップされた ペイロード は失敗します。

## What changed

- `cron.add` と `cron.update` が一般的な ラッパー 形状を正規化し、不足している `kind` フィールドを推論するようになりました。
- エージェント の cron ツール スキーマが ゲートウェイ のスキーマと一致し、無効な ペイロード が減少しました。
- プロバイダの列挙は、ゲートウェイ、CLI、UI、およびmacOSピッカーで整列されます。
- Control UI は ステータス 用に ゲートウェイ の `jobs` 件数 フィールドを使用します。

## Current behavior

- **Normalization:** ラップされた `data`/`job` ペイロードは アンラップ され、安全な場合は `schedule.kind` と `payload.kind` が推論されます。
- **Defaults:** 不足している場合、`wakeMode` と `sessionTarget` に安全な デフォルト が適用されます。
- **Providers:** Discord/Slack/Signal/iMessage が CLI/UI 全体で一貫して表示されるようになりました。

正規化された 形状 と 例 については、[Cron jobs](/automation/cron-jobs) を参照してください。

## Verification

- ゲートウェイ ログを監視し、`cron.add` INVALID_REQUEST エラーが減少していることを確認します。
- Control UI の cron ステータスが、更新後に ジョブ 件数を表示することを確認します。

## Optional Follow-ups

- Control UI の 手動 スモーク テスト：プロバイダー ごとに cron ジョブ を 1 つ追加し、ステータス の ジョブ 件数を確認します。

## Open Questions

- `cron.add` は、クライアント からの 明示的な `state` を受け付けるべきでしょうか（現在は スキーマ により不許可ですか）？
- `webchat` を 明示的な 配送 プロバイダー として許可すべきでしょうか（現在は 配送 解決 で フィルタリング されています）？
