---
summary: "「openclaw setup」（設定とワークスペースを初期化）の CLI リファレンス"
read_when:
  - フルのオンボーディングウィザードを使用せずに初回セットアップを行う場合
  - デフォルトのワークスペースパスを設定したい場合
title: "セットアップ"
---

# `openclaw setup`

`~/.openclaw/openclaw.json` とエージェントのワークスペースを初期化します。

関連項目:

- はじめに: [Getting started](/start/getting-started)
- ウィザード: [Onboarding](/start/onboarding)

## 例

```bash
openclaw setup
openclaw setup --workspace ~/.openclaw/workspace
```

setup 経由でウィザードを実行するには:

```bash
openclaw setup --wizard
```
