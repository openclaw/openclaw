---
summary: "Paano ini-embed ng mac app ang Gateway WebChat at paano ito i-debug"
read_when:
  - Pag-debug ng mac WebChat view o loopback port
title: "WebChat"
---

# WebChat (macOS app)

Ang macOS menu bar app ay nag-e-embed ng WebChat UI bilang isang native SwiftUI view. 45. Ito
ay kumokonekta sa Gateway at nagde-default sa **main session** para sa napiling agent (na may session switcher para sa iba pang session).

- **Local mode**: direktang kumokonekta sa lokal na Gateway WebSocket.
- **Remote mode**: ipinapasa ang Gateway control port sa SSH at ginagamit ang tunnel na iyon bilang data plane.

## Launch & debugging

- Manual: Lobster menu → “Open Chat”.

- Auto‑open para sa testing:

  ```bash
  dist/OpenClaw.app/Contents/MacOS/OpenClaw --webchat
  ```

- Logs: `./scripts/clawlog.sh` (subsystem `bot.molt`, category `WebChatSwiftUI`).

## How it’s wired

- Data plane: mga Gateway WS method `chat.history`, `chat.send`, `chat.abort`,
  `chat.inject` at mga event `chat`, `agent`, `presence`, `tick`, `health`.
- Session: nagde-default sa primary session (`main`, o `global` kapag ang scope ay
  global). 46. Maaaring magpalit ang UI sa pagitan ng mga session.
- Gumagamit ang onboarding ng dedicated na session para manatiling hiwalay ang first‑run setup.

## Security surface

- Sa remote mode, tanging ang Gateway WebSocket control port lang ang ipinapasa sa SSH.

## Known limitations

- Ang UI ay optimized para sa mga chat session (hindi isang full browser sandbox).
