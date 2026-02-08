---
summary: "Telegram 許可リストの強化：プレフィックス + 空白の正規化"
read_when:
  - これまでの Telegram 許可リストの変更を確認する際
title: "Telegram 許可リストの強化"
x-i18n:
  source_path: experiments/plans/group-policy-hardening.md
  source_hash: 70569968857d4084
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:21:43Z
---

# Telegram 許可リストの強化

**日付**: 2026-01-05  
**ステータス**: 完了  
**PR**: #216

## 概要

Telegram 許可リストでは、`telegram:` および `tg:` のプレフィックスを大文字・小文字を区別せずに受け付け、誤って含まれた空白も許容するようになりました。これにより、受信側の許可リストチェックが、送信時の正規化と整合します。

## 変更内容

- プレフィックス `telegram:` と `tg:` は同一として扱われます（大文字・小文字を区別しません）。
- 許可リストのエントリはトリミングされ、空のエントリは無視されます。

## 例

以下はいずれも同一の ID として受け付けられます。

- `telegram:123456`
- `TG:123456`
- `tg:123456`

## 重要性

ログやチャット ID からのコピー＆ペーストには、プレフィックスや空白が含まれることがよくあります。正規化により、ダイレクトメッセージやグループで応答するかどうかを判断する際の誤検知（偽陰性）を防げます。

## 関連ドキュメント

- [Group Chats](/channels/groups)
- [Telegram Provider](/channels/telegram)
