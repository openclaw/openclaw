---
read_when:
    - チャネルの健全性と最近のセッション受信者を素早く診断したい場合
    - デバッグ用にコピー可能な「all」ステータスが欲しい場合
summary: '`openclaw status`（診断、プローブ、使用状況スナップショット）のCLIリファレンス'
title: status
x-i18n:
    generated_at: "2026-04-02T07:35:54Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: f01241b2cfa90dee2ff77ae5a2cbc30a2cb8963e431ced658d4c00db4d80026b
    source_path: cli/status.md
    workflow: 15
---

# `openclaw status`

チャネルとセッションの診断。

```bash
openclaw status
openclaw status --all
openclaw status --deep
openclaw status --usage
```

注意事項:

- `--deep` はライブプローブを実行します（WhatsApp Web + Telegram + Discord + Google Chat + Slack + Signal）。
- 複数のエージェントが設定されている場合、出力にはエージェントごとのセッションストアが含まれます。
- 概要には、利用可能な場合 Gateway ゲートウェイ + ノードホストサービスのインストール/ランタイム状態が含まれます。
- 概要にはアップデートチャネル + git SHA（ソースチェックアウトの場合）が含まれます。
- アップデート情報は概要に表示されます。アップデートが利用可能な場合、status は `openclaw update` の実行を促すヒントを出力します（[アップデート](/install/updating)を参照）。
- 読み取り専用のステータス表示（`status`、`status --json`、`status --all`）は、可能な場合、対象の設定パスについてサポートされている SecretRef を解決します。
- サポートされているチャネルの SecretRef が設定されているが現在のコマンドパスで利用できない場合、status は読み取り専用のまま、クラッシュせずに機能低下した出力を報告します。人間向け出力では「configured token unavailable in this command path」などの警告が表示され、JSON 出力には `secretDiagnostics` が含まれます。
- コマンドローカルの SecretRef 解決が成功した場合、status は解決されたスナップショットを優先し、最終出力から一時的な「secret unavailable」チャネルマーカーをクリアします。
- `status --all` には Secrets の概要行と、シークレット診断を要約する診断セクション（可読性のために切り詰められます）が含まれ、レポート生成を停止しません。
