# 2026-02-21: Full Autonomy & Core Plugin Delegation

## 概要 (Overview)

ユーザーの要望「openclawの全機能をbotに全面委任させたい」に基づき、OpenClawのAIエージェントにPC全体およびシステムの全機能（ファイル操作・シェルアクセス・自律サブタスク構築など）へのフルアクセス権限を付与しました。
（以前実施したHeartbeat短縮・Auto-Agent有効化の設定に上乗せする形での完全委任となります）

## 変更内容 (Modifications)

対象ファイル: `~/.openclaw/config.json`

### 1. コマンド実行の完全委任 (Full Shell Delegation)

- `agents.list[0].tools.exec.ask` の値を `"on-miss"` から `"never"` に変更。
- これにより、未知のコマンドやシステム変更を伴うシェルコマンド（アプリ起動、ファイル削除、スクリプト実行等）を実行する際に、**ユーザープロンプト（Y/Nの確認）を待たずにAI自らの判断で即時実行**するようになります。

### 2. 自律操作の明示的有効化 (Heartbeat Enforcement)

- `agents.defaults.heartbeat.every`: `"5m"` → `"1m"` (以前の設定)
- `agents.defaults.heartbeat.enabled: true` を明示追加。
- バックグラウンドでAIが1分ごとに状態を監視し、自発的タスク（エラー修復や情報探索）を行うループを強化・確実化しました。

### 3. コアプラグインの全解放 (Unlocking Core Plugins)

以下の無効化されていたプラグインを `"enabled": true` に設定しました。

- `memory-core`: 過去のやり取りやシステム状態を自律的に記憶・検索する長期記憶モジュール。
- `llm-task`: AI自身が複雑なタスクを分解し、バックグラウンドで子エージェント（サブタスク）プロセスをスピンアップして並列処理する機能。
- `vrchat-relay`: VRChat稼働時にOSC等を通じて自律的にフック・干渉する機能。

### 4. Auto-Agent（自律実行・自動調整）の強化 (以前の設定の維持)

- `plugins.entries['auto-agent'].config.checkIntervalMs`: `60000` → `10000`
- `plugins.entries['auto-agent'].config.gitAutoCommit`: `false` → `true`

---

## 運用上の注意 (Operational Warning)

本設定により、OpenClawはシステム上で**ユーザーと同等の権限を持つほぼ完全な非監視エージェント**として動作します。
自律的にコードを書き換えてGitコミットを行ったり、サブタスクを生成してウェブ検索を行ったりできるため非常に強力ですが、予期せぬスクリプトの実行やリソースの消費が発生する可能性があるため、定期的なログの確認やターミナルでの挙動監視を推奨します。

※変更を適用するために、起動中のOpenClawターミナルを再起動（Ctrl+Cして再度 `OpenClaw-All-In-One.bat` 等から起動）してください。
