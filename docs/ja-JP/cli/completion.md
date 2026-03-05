---
summary: "`openclaw completion` のCLIリファレンス（シェル補完スクリプトの生成・インストール）"
read_when:
  - zsh/bash/fish/PowerShell のシェル補完が必要な場合
  - OpenClaw の状態ディレクトリに補完スクリプトをキャッシュしたい場合
title: "completion"
x-i18n:
  source_path: "docs/cli/completion.md"
  generated_at: "2026-03-05T10:01:00Z"
  model: "claude-opus-4-6"
  provider: "pi"
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

- `-s, --shell <shell>`: シェルターゲット（`zsh`、`bash`、`powershell`、`fish`、デフォルト: `zsh`）
- `-i, --install`: シェルプロファイルにソース行を追加して補完をインストール
- `--write-state`: 標準出力に表示せず、補完スクリプトを `$OPENCLAW_STATE_DIR/completions` に書き込む
- `-y, --yes`: インストール確認プロンプトをスキップ

## 備考

- `--install` はシェルプロファイルに小さな「OpenClaw Completion」ブロックを書き込み、キャッシュされたスクリプトを参照します。
- `--install` や `--write-state` を指定しない場合、コマンドはスクリプトを標準出力に表示します。
- 補完生成はコマンドツリーを積極的に読み込むため、ネストされたサブコマンドも含まれます。
