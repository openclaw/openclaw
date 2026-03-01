---
summary: "`openclaw setup` の CLI リファレンス（設定 + ワークスペースの初期化）"
read_when:
  - 完全なオンボーディングウィザードなしで初回セットアップを行う場合
  - デフォルトのワークスペースパスを設定したい場合
title: "setup"
---

# `openclaw setup`

`~/.openclaw/openclaw.json` とエージェントワークスペースを初期化します。

関連:

- はじめに: [はじめに](/start/getting-started)
- ウィザード: [オンボーディング](/start/onboarding)

## 例

```bash
openclaw setup
openclaw setup --workspace ~/.openclaw/workspace
```

setup 経由でウィザードを実行する場合:

```bash
openclaw setup --wizard
```
