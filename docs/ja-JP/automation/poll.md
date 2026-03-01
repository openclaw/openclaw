---
summary: "Gateway + CLI 経由のポール送信"
read_when:
  - ポールサポートの追加または変更
  - CLI または Gateway からのポール送信のデバッグ
title: "ポール"
---

# ポール

## サポートされているチャンネル

- WhatsApp（Web チャンネル）
- Discord
- MS Teams（アダプティブカード）

## CLI

```bash
# WhatsApp
openclaw message poll --target +15555550123 \
  --poll-question "Lunch today?" --poll-option "Yes" --poll-option "No" --poll-option "Maybe"
openclaw message poll --target 123456789@g.us \
  --poll-question "Meeting time?" --poll-option "10am" --poll-option "2pm" --poll-option "4pm" --poll-multi

# Discord
openclaw message poll --channel discord --target channel:123456789 \
  --poll-question "Snack?" --poll-option "Pizza" --poll-option "Sushi"
openclaw message poll --channel discord --target channel:123456789 \
  --poll-question "Plan?" --poll-option "A" --poll-option "B" --poll-duration-hours 48

# MS Teams
openclaw message poll --channel msteams --target conversation:19:abc@thread.tacv2 \
  --poll-question "Lunch?" --poll-option "Pizza" --poll-option "Sushi"
```

オプション:

- `--channel`: `whatsapp`（デフォルト）、`discord`、または `msteams`
- `--poll-multi`: 複数のオプションの選択を許可します
- `--poll-duration-hours`: Discord のみ（省略時のデフォルトは 24）

## Gateway RPC

メソッド: `poll`

パラメータ:

- `to`（文字列、必須）
- `question`（文字列、必須）
- `options`（文字列の配列、必須）
- `maxSelections`（数値、オプション）
- `durationHours`（数値、オプション）
- `channel`（文字列、オプション、デフォルト: `whatsapp`）
- `idempotencyKey`（文字列、必須）

## チャンネルの違い

- WhatsApp: 2〜12 個のオプション。`maxSelections` はオプション数以内である必要があります。`durationHours` は無視されます。
- Discord: 2〜10 個のオプション。`durationHours` は 1〜768 時間にクランプされます（デフォルト 24）。`maxSelections > 1` でマルチセレクトが有効になります。Discord は厳密な選択数をサポートしません。
- MS Teams: アダプティブカードポール（OpenClaw 管理）。ネイティブのポール API はなく、`durationHours` は無視されます。

## エージェントツール（Message）

`message` ツールを `poll` アクションで使用します（`to`、`pollQuestion`、`pollOption`、オプションの `pollMulti`、`pollDurationHours`、`channel`）。

注意: Discord には「正確に N 個を選ぶ」モードがありません。`pollMulti` はマルチセレクトにマップされます。Teams のポールはアダプティブカードとしてレンダリングされ、Gateway がオンラインであることが必要です（投票は `~/.openclaw/msteams-polls.json` に記録されます）。
