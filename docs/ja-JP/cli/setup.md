---
read_when:
    - 完全な CLI オンボーディングなしで初回セットアップを行う場合
    - デフォルトのワークスペースパスを設定したい場合
summary: '`openclaw setup`（設定とワークスペースの初期化）の CLI リファレンス'
title: setup
x-i18n:
    generated_at: "2026-04-02T07:35:41Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: af3b7a8e830cc5babc071eebee514432059f49fec7287a59c0d7198648505139
    source_path: cli/setup.md
    workflow: 15
---

# `openclaw setup`

`~/.openclaw/openclaw.json` とエージェントワークスペースを初期化します。

関連:

- はじめに: [はじめに](/start/getting-started)
- CLI オンボーディング: [オンボーディング（CLI）](/start/wizard)

## 使用例

```bash
openclaw setup
openclaw setup --workspace ~/.openclaw/workspace
```

セットアップ経由でオンボーディングを実行するには:

```bash
openclaw setup --wizard
```
