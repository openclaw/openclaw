# プラグインの有効化および設定の自動修復

## 日付

2026-02-20

## 目的

ユーザーからの要求「ドクターフィックス LINEDiscord使用可能にしてコミットプッシュして」に従い、システム環境の健全性を確保しつつ必要なChattingプラットフォーム連携を有効にする。

## 実装内容

1. **設定警告の修復 (`openclaw doctor --fix`)**:
   - `openclaw doctor` で指摘されていた `channels.line.allowFrom` へのワイルドカード追加などの不具合を自動修復。
   - `config.json` におけるDM開放ポリシーとの整合性を確保した。

2. **LINE・Discordプラグインの有効化**:
   - npm経由のインストールが不要な組み込み版のプラグインを利用。
   - CLIから `openclaw plugins enable line` および `openclaw plugins enable discord` を実行し、それぞれの拡張をONに設定した（再起動後に反映）。

3. **反映のコミット・プッシュ**:
   - コードベース群や修正ドキュメント（バグ修理等）を含めて `git add .` でステージし、ここまでの実装内容をコミットし、メインブランチへプッシュした。

## 状態・検証

- `config.json` の `plugins.entries` 内において、`line` と `discord` の `enabled` プロパティが `true` となっていることを確認。
- `doctor` モジュールのエラー出力が解消されている。

以上
