---
summary: "`openclaw setup` のCLIリファレンス（設定とワークスペースの初期化）"
read_when:
  - 完全なオンボーディングウィザードを使わずに初回セットアップを行う場合
  - デフォルトのワークスペースパスを設定したい場合
title: "setup"
---

# `openclaw setup`

`~/.openclaw/openclaw.json` とエージェントワークスペースを初期化します。

関連：

- はじめに：[はじめに](/start/getting-started)
- ウィザード：[オンボーディング](/start/onboarding)

## 使用例

```bash
openclaw setup
openclaw setup --workspace ~/.openclaw/workspace
```

ウィザードを setup 経由で実行するには：

```bash
openclaw setup --wizard
```
