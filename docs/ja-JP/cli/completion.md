---
read_when:
    - zsh/bash/fish/PowerShellのシェル補完が必要な場合
    - OpenClawのステートディレクトリに補完スクリプトをキャッシュしたい場合
summary: '`openclaw completion` のCLIリファレンス（シェル補完スクリプトの生成/インストール）'
title: completion
x-i18n:
    generated_at: "2026-04-02T07:33:00Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: 7bbf140a880bafdb7140149f85465d66d0d46e5a3da6a1e41fb78be2fd2bd4d0
    source_path: cli/completion.md
    workflow: 15
---

# `openclaw completion`

シェル補完スクリプトを生成し、オプションでシェルプロファイルにインストールします。

## 使い方

```bash
openclaw completion
openclaw completion --shell zsh
openclaw completion --install
openclaw completion --shell fish --install
openclaw completion --write-state
openclaw completion --shell bash --write-state
```

## オプション

- `-s, --shell <shell>`：シェルターゲット（`zsh`、`bash`、`powershell`、`fish`、デフォルト：`zsh`）
- `-i, --install`：シェルプロファイルにsource行を追加して補完をインストール
- `--write-state`：補完スクリプトを `$OPENCLAW_STATE_DIR/completions` に書き出し、stdoutには出力しない
- `-y, --yes`：インストール確認プロンプトをスキップ

## 注意事項

- `--install` はシェルプロファイルに小さな「OpenClaw Completion」ブロックを書き込み、キャッシュされたスクリプトを参照するようにします。
- `--install` または `--write-state` を指定しない場合、コマンドはスクリプトをstdoutに出力します。
- 補完の生成はコマンドツリーを即座に読み込むため、ネストされたサブコマンドも含まれます。
