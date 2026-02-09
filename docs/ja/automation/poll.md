---
summary: "Gateway（ゲートウェイ） + CLI による投票の送信"
read_when:
  - 投票サポートの追加または変更時
  - CLI または ゲートウェイ からの投票送信をデバッグする際
title: "投票"
---

# 投票

## サポートされているチャンネル

- WhatsApp（web チャンネル）
- Discord
- MS Teams（Adaptive Cards）

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
- `--poll-multi`: 複数オプションの選択を許可します
- `--poll-duration-hours`: Discord 専用（省略時は 24）

## Gateway RPC

メソッド: `poll`

Params:

- `to`（string、必須）
- `question`（string、必須）
- `options`（string[]、必須）
- `maxSelections`（number、任意）
- `durationHours`（number、任意）
- `channel`（string、任意、デフォルト: `whatsapp`）
- `idempotencyKey`（string、必須）

## チャンネルの違い

- WhatsApp: 2～12 個のオプション。`maxSelections` はオプション数の範囲内である必要があります。`durationHours` は無視されます。
- Discord: 2-10 options, `durationHours` は 1-768 hours にクランプされています(デフォルトは 24)。 Discord: 2～10 個のオプション。`durationHours` は 1～768 時間にクランプされます（デフォルト 24）。`maxSelections > 1` により複数選択が有効になります。Discord は厳密な選択数の指定をサポートしていません。
- MS Teams: Adaptive Card による投票（OpenClaw 管理）。ネイティブの投票 API はありません。`durationHours` は無視されます。 ネイティブのpoll APIはありません。`durationHours` は無視されます。

## エージェントツール（Message）

`message` ツールを `poll` アクション（`to`、`pollQuestion`、`pollOption`、任意の `pollMulti`、`pollDurationHours`、`channel`）とともに使用します。

注記: Discord には「正確に N 個選択」のモードはありません。`pollMulti` は複数選択にマッピングされます。
Teams の投票は Adaptive Card としてレンダリングされ、`~/.openclaw/msteams-polls.json` で投票を記録するために ゲートウェイ がオンラインのままである必要があります。
チームの投票はAdaptive Cardsとしてレンダリングされ、`~/.openclaw/msteams-polls.json` で投票を記録するためには、オンラインの
のままにする必要があります。
