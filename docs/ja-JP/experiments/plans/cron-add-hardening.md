---
last_updated: "2026-01-05"
owner: openclaw
status: complete
summary: cron.addの入力処理を堅牢化し、スキーマを整合させ、cron UI/エージェントツールを改善
title: Cron Add堅牢化
---

# Cron Add堅牢化 & スキーマ整合

## 背景

最近のGatewayログで、無効なパラメータ（`sessionTarget`、`wakeMode`、`payload`の欠落、不正な`schedule`形式）による`cron.add`の繰り返し失敗が確認されました。これは、少なくとも1つのクライアント（おそらくエージェントツール呼び出しパス）がラップされた、または部分的に指定されたタスクペイロードを送信していることを示しています。また、TypeScriptのcronプロバイダー列挙、Gatewayスキーマ、CLIフラグ、UIフォームタイプの間にドリフトが発生しており、`cron.status`のUI不整合（`jobCount`を期待するがGatewayは`jobs`を返す）もあります。

## 目標

- 一般的なラップされたペイロードの正規化と欠落した`kind`フィールドの推論により、`cron.add` INVALID_REQUESTエラーを解消する。
- Gatewayスキーマ、cronタイプ、CLIドキュメント、UIフォーム間でcronプロバイダーリストを整合させる。
- エージェントcronツールスキーマを明確にし、LLMが正しいタスクペイロードを生成できるようにする。
- Control UIのcronステータスタスクカウント表示を修正する。
- 正規化とツール動作をカバーするテストを追加する。

## 非目標

- cronスケジュールのセマンティクスやタスク実行動作の変更。
- 新しいスケジュールタイプやcron式パーサーの追加。
- 必要なフィールド修正以外のcron UI/UXの大幅な変更。

## 発見（現在のギャップ）

- Gatewayの`CronPayloadSchema`が`signal` + `imessage`を除外しているが、TypeScript型には含まれている。
- Control UIのCronStatusが`jobCount`を期待しているが、Gatewayは`jobs`を返している。
- エージェントcronツールスキーマが任意の`job`オブジェクトを許可しており、不正な入力の原因となっている。
- Gatewayが正規化なしで`cron.add`を厳密にバリデーションするため、ラップされたペイロードが失敗する。

## 変更内容

- `cron.add`と`cron.update`が一般的なラップ形式を正規化し、欠落した`kind`フィールドを推論するようになりました。
- エージェントcronツールスキーマがGatewayスキーマと一致し、無効なペイロードを削減しました。
- プロバイダー列挙がGateway、CLI、UI、macOSセレクター間で整合されました。
- Control UIがGatewayの`jobs`カウントフィールドを使用してステータスを表示するようになりました。

## 現在の動作

- **正規化：** ラップされた`data`/`job`ペイロードがアンラップされ、`schedule.kind`と`payload.kind`が安全な場合に推論されます。
- **デフォルト値：** 欠落時に`wakeMode`と`sessionTarget`に安全なデフォルト値が適用されます。
- **プロバイダー：** Discord/Slack/Signal/iMessageがCLI/UIで一貫して表示されるようになりました。

正規化の形式と例については[Cronジョブ](/automation/cron-jobs)を参照してください。

## 検証

- GatewayログでのI`cron.add` INVALID_REQUESTエラーの減少を確認する。
- Control UIのcronステータスがリフレッシュ後にタスクカウントを表示することを確認する。

## オプションのフォローアップ

- 手動Control UIスモークテスト：各プロバイダーでcronタスクを追加し、ステータスのタスクカウントを検証する。

## 未解決の問題

- `cron.add`はクライアントからの明示的な`state`を受け入れるべきか（現在スキーマで禁止されている）？
- `webchat`を明示的な配信プロバイダーとして許可すべきか（現在は配信解決で除外されている）？
