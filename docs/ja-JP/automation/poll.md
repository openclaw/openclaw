---
read_when:
    - 投票サポートの追加または変更時
    - CLI または Gateway ゲートウェイからの投票送信のデバッグ時
summary: Gateway + CLI を使った投票の送信
title: 投票
x-i18n:
    generated_at: "2026-04-02T07:30:10Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: 9f867aa7f00b7e96bbaa2413230eff4e99fc3284411b46afe9081cb8f4809bce
    source_path: automation/poll.md
    workflow: 15
---

# 投票

## サポートされているチャネル

- Telegram
- WhatsApp（Web チャネル）
- Discord
- Microsoft Teams（Adaptive Cards）

## CLI

```bash
# Telegram
openclaw message poll --channel telegram --target 123456789 \
  --poll-question "Ship it?" --poll-option "Yes" --poll-option "No"
openclaw message poll --channel telegram --target -1001234567890:topic:42 \
  --poll-question "Pick a time" --poll-option "10am" --poll-option "2pm" \
  --poll-duration-seconds 300

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

# Microsoft Teams
openclaw message poll --channel msteams --target conversation:19:abc@thread.tacv2 \
  --poll-question "Lunch?" --poll-option "Pizza" --poll-option "Sushi"
```

オプション:

- `--channel`: `whatsapp`（デフォルト）、`telegram`、`discord`、または `msteams`
- `--poll-multi`: 複数選択を許可
- `--poll-duration-hours`: Discord 専用（省略時のデフォルトは 24）
- `--poll-duration-seconds`: Telegram 専用（5〜600 秒）
- `--poll-anonymous` / `--poll-public`: Telegram 専用の投票公開設定

## Gateway ゲートウェイ RPC

メソッド: `poll`

パラメータ:

- `to`（string、必須）
- `question`（string、必須）
- `options`（string[]、必須）
- `maxSelections`（number、省略可）
- `durationHours`（number、省略可）
- `durationSeconds`（number、省略可、Telegram 専用）
- `isAnonymous`（boolean、省略可、Telegram 専用）
- `channel`（string、省略可、デフォルト: `whatsapp`）
- `idempotencyKey`（string、必須）

## チャネルごとの差異

- Telegram: 2〜10 個の選択肢。`threadId` または `:topic:` ターゲットによるフォーラムトピックをサポート。`durationHours` の代わりに `durationSeconds` を使用し、5〜600 秒に制限。匿名投票と公開投票をサポート。
- WhatsApp: 2〜12 個の選択肢。`maxSelections` は選択肢の数以内でなければならない。`durationHours` は無視される。
- Discord: 2〜10 個の選択肢。`durationHours` は 1〜768 時間にクランプされる（デフォルト 24）。`maxSelections > 1` で複数選択が有効になる。Discord は厳密な選択数の指定をサポートしていない。
- Microsoft Teams: Adaptive Card による投票（OpenClaw 管理）。ネイティブの投票 API はなく、`durationHours` は無視される。

## エージェントツール（Message）

`message` ツールの `poll` アクション（`to`、`pollQuestion`、`pollOption`、省略可能な `pollMulti`、`pollDurationHours`、`channel`）を使用します。

Telegram の場合、ツールは `pollDurationSeconds`、`pollAnonymous`、`pollPublic` も受け付けます。

投票の作成には `action: "poll"` を使用します。`action: "send"` と共に投票フィールドを渡すと拒否されます。

注意: Discord には「正確に N 個を選ぶ」モードはありません。`pollMulti` は複数選択にマッピングされます。
Teams の投票は Adaptive Cards としてレンダリングされ、投票を `~/.openclaw/msteams-polls.json` に記録するために Gateway ゲートウェイがオンラインである必要があります。
