---
summary: "Pagpapatibay ng Telegram allowlist: prefix + normalisasyon ng whitespace"
read_when:
  - Pagsusuri ng mga historikal na pagbabago sa Telegram allowlist
title: "Pagpapatibay ng Telegram Allowlist"
x-i18n:
  source_path: experiments/plans/group-policy-hardening.md
  source_hash: 70569968857d4084
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:45:23Z
---

# Pagpapatibay ng Telegram Allowlist

**Petsa**: 2026-01-05  
**Katayuan**: Kumpleto  
**PR**: #216

## Buod

Tumatanggap na ngayon ang mga Telegram allowlist ng mga prefix na `telegram:` at `tg:` nang hindi sensitibo sa case, at pinapayagan ang
hindi sinasadyang whitespace. Inaayon nito ang mga inbound allowlist check sa outbound send normalization.

## Ano ang nagbago

- Ang mga prefix na `telegram:` at `tg:` ay tinatrato nang pareho (case-insensitive).
- Ang mga entry sa allowlist ay tinitrim; ang mga walang laman na entry ay binabalewala.

## Mga halimbawa

Lahat ng ito ay tinatanggap para sa parehong ID:

- `telegram:123456`
- `TG:123456`
- `tg:123456`

## Bakit ito mahalaga

Ang pag-copy/paste mula sa mga log o chat ID ay madalas may kasamang mga prefix at whitespace. Ang normalisasyon ay umiiwas sa
mga false negative kapag nagpapasya kung tutugon sa mga DM o group.

## Kaugnay na docs

- [Group Chats](/channels/groups)
- [Telegram Provider](/channels/telegram)
