---
summary: "Semantika ng reaksyon na ibinabahagi sa iba’t ibang channel"
read_when:
  - Kapag nagtatrabaho sa mga reaksyon sa anumang channel
title: "Mga Reaksyon"
x-i18n:
  source_path: tools/reactions.md
  source_hash: 0f11bff9adb4bd02
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:45:53Z
---

# Mga tool para sa reaksyon

Ibinabahaging semantika ng reaksyon sa iba’t ibang channel:

- Kailangan ang `emoji` kapag nagdadagdag ng reaksyon.
- Inaalis ng `emoji=""` ang (mga) reaksyon ng bot kapag suportado.
- Inaalis ng `remove: true` ang tinukoy na emoji kapag suportado (nangangailangan ng `emoji`).

Mga tala ayon sa channel:

- **Discord/Slack**: ang walang laman na `emoji` ay nag-aalis ng lahat ng reaksyon ng bot sa mensahe; ang `remove: true` ay nag-aalis lang ng partikular na emoji.
- **Google Chat**: ang walang laman na `emoji` ay nag-aalis ng mga reaksyon ng app sa mensahe; ang `remove: true` ay nag-aalis lang ng partikular na emoji.
- **Telegram**: ang walang laman na `emoji` ay nag-aalis ng mga reaksyon ng bot; ang `remove: true` ay nag-aalis din ng mga reaksyon ngunit nangangailangan pa rin ng hindi walang laman na `emoji` para sa tool validation.
- **WhatsApp**: ang walang laman na `emoji` ay nag-aalis ng reaksyon ng bot; ang `remove: true` ay tumutugma sa walang lamang emoji (nangangailangan pa rin ng `emoji`).
- **Signal**: ang mga papasok na notification ng reaksyon ay naglalabas ng mga system event kapag naka-enable ang `channels.signal.reactionNotifications`.
