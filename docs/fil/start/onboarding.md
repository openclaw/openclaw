---
summary: "Onboarding sa unang pagtakbo para sa OpenClaw (macOS app)"
read_when:
  - Pagdidisenyo ng macOS onboarding assistant
  - Pagpapatupad ng auth o identity setup
title: "Onboarding (macOS App)"
sidebarTitle: "Onboarding: macOS App"
x-i18n:
  source_path: start/onboarding.md
  source_hash: 45f912067527158f
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:46:00Z
---

# Onboarding (macOS App)

Inilalarawan ng dokumentong ito ang **kasalukuyang** daloy ng onboarding sa unang pagtakbo. Ang layunin ay isang
maayos na “day 0” na karanasan: piliin kung saan tatakbo ang Gateway, ikonekta ang auth, patakbuhin ang wizard, at hayaan ang agent na i‑bootstrap ang sarili nito.

<Steps>
<Step title="Aprubahan ang babala ng macOS">
<Frame>
<img src="/assets/macos-onboarding/01-macos-warning.jpeg" alt="" />
</Frame>
</Step>
<Step title="Aprubahan ang paghahanap ng mga lokal na network">
<Frame>
<img src="/assets/macos-onboarding/02-local-networks.jpeg" alt="" />
</Frame>
</Step>
<Step title="Welcome at abiso sa seguridad">
<Frame caption="Basahin ang ipinapakitang abiso sa seguridad at magpasya nang naaayon">
<img src="/assets/macos-onboarding/03-security-notice.png" alt="" />
</Frame>
</Step>
<Step title="Lokal vs Remote">
<Frame>
<img src="/assets/macos-onboarding/04-choose-gateway.png" alt="" />
</Frame>

Saan tatakbo ang **Gateway**?

- **Itong Mac (Lokal lamang):** puwedeng patakbuhin ng onboarding ang mga OAuth flow at magsulat ng mga credential
  nang lokal.
- **Remote (sa SSH/Tailnet):** **hindi** nagpapatakbo ng OAuth nang lokal ang onboarding;
  dapat umiiral na ang mga credential sa host ng gateway.
- **I-configure sa ibang pagkakataon:** laktawan ang setup at iwanang hindi pa naka-configure ang app.

<Tip>
**Tip sa Gateway auth:**
- Gumagawa na ngayon ang wizard ng **token** kahit para sa loopback, kaya kailangang mag-authenticate ang mga lokal na WS client.
- Kapag dine-disable ang auth, anumang lokal na proseso ay puwedeng kumonek; gamitin lamang ito sa mga ganap na pinagkakatiwalaang machine.
- Gumamit ng **token** para sa multi‑machine access o mga non‑loopback bind.
</Tip>
</Step>
<Step title="Mga permiso">
<Frame caption="Piliin kung aling mga permiso ang nais mong ibigay sa OpenClaw">
<img src="/assets/macos-onboarding/05-permissions.png" alt="" />
</Frame>

Humihingi ang onboarding ng mga TCC permission na kailangan para sa:

- Automation (AppleScript)
- Mga Notification
- Accessibility
- Screen Recording
- Mikropono
- Speech Recognition
- Camera
- Lokasyon

</Step>
<Step title="CLI">
  <Info>Opsyonal ang hakbang na ito</Info>
  Maaaring i-install ng app ang global `openclaw` CLI sa pamamagitan ng npm/pnpm upang gumana agad ang mga terminal
  workflow at mga launchd task.
</Step>
<Step title="Onboarding Chat (dedikadong session)">
  Pagkatapos ng setup, magbubukas ang app ng isang dedikadong onboarding chat session upang maipakilala ng agent
  ang sarili nito at gabayan ang mga susunod na hakbang. Pinapanatiling hiwalay nito ang gabay sa unang pagtakbo
  mula sa iyong normal na usapan. Tingnan ang [Bootstrapping](/start/bootstrapping) para sa
  kung ano ang nangyayari sa host ng Gateway sa unang pagtakbo ng agent.
</Step>
</Steps>
