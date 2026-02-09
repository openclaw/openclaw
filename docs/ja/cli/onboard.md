---
summary: "CLI 参照用ドキュメント：`openclaw onboard`（対話型オンボーディング ウィザード）"
read_when:
  - ゲートウェイ、ワークスペース、認証、チャンネル、Skills のガイド付きセットアップを行いたい場合
title: "オンボード"
---

# `openclaw onboard`

対話型オンボーディング ウィザード（ローカルまたはリモートの Gateway セットアップ）。

## Related guides

- CLI オンボーディング ハブ： [Onboarding Wizard (CLI)](/start/wizard)
- CLI オンボーディング参照： [CLI Onboarding Reference](/start/wizard-cli-reference)
- CLI 自動化： [CLI Automation](/start/wizard-cli-automation)
- macOS オンボーディング： [Onboarding (macOS App)](/start/onboarding)

## Examples

```bash
openclaw onboard
openclaw onboard --flow quickstart
openclaw onboard --flow manual
openclaw onboard --mode remote --remote-url ws://gateway-host:18789
```

フローに関する注記：

- `quickstart`：最小限のプロンプトで、ゲートウェイ トークンを自動生成します。
- `manual`：ポート／バインド／認証の完全なプロンプト（`advanced` のエイリアス）。
- 最速で最初のチャット： `openclaw dashboard`（コントロール UI、チャンネル設定なし）。

## Common follow-up commands

```bash
openclaw configure
openclaw agents add <name>
```

<Note>

`--json` は非対話モードを意味しません。スクリプトでは `--non-interactive` を使用してください。
 スクリプトには `--non-interactive` を使用します。
</Note>
