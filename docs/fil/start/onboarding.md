---
summary: "Onboarding sa unang pagtakbo para sa OpenClaw (macOS app)"
read_when:
  - Pagdidisenyo ng macOS onboarding assistant
  - Pagpapatupad ng auth o identity setup
title: "Onboarding (macOS App)"
sidebarTitle: "Onboarding: macOS App"
---

# Onboarding (macOS App)

This doc describes the **current** first‑run onboarding flow. The goal is a
smooth “day 0” experience: pick where the Gateway runs, connect auth, run the
wizard, and let the agent bootstrap itself.

<Steps>
<Step title="Approve macOS warning">
<Frame>
<img src="/assets/macos-onboarding/01-macos-warning.jpeg" alt="" />
</Frame>
</Step>
<Step title="Approve find local networks">
<Frame>
<img src="/assets/macos-onboarding/02-local-networks.jpeg" alt="" />
</Frame>
</Step>
<Step title="Welcome and security notice">
<Frame caption="Basahin ang ipinapakitang abiso sa seguridad at magpasya nang naaayon">
<img src="/assets/macos-onboarding/03-security-notice.png" alt="" />
</Frame>
</Step>
<Step title="Local vs Remote">
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
**Tip sa gateway auth:**
- Gumagawa na ngayon ang wizard ng **token** kahit para sa loopback, kaya kailangang mag‑authenticate ang mga lokal na WS client.
- Kung idi-disable mo ang auth, anumang lokal na proseso ay puwedeng kumonek; gamitin lamang ito sa mga ganap na pinagkakatiwalaang makina.
- Gumamit ng **token** para sa multi‑machine access o mga non‑loopback bind.
</Tip>
</Step>
<Step title="Permissions">
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
<Step title="Onboarding Chat (dedicated session)">
  Pagkatapos ng setup, awtomatikong magbubukas ang app ng isang hiwalay na onboarding chat session upang maipakilala ng agent ang sarili nito at magabayan ang mga susunod na hakbang. Pinananatili nitong hiwalay ang gabay sa unang paggamit mula sa iyong normal na usapan. Tingnan ang [Bootstrapping](/start/bootstrapping) para sa kung ano ang nangyayari sa gateway host sa unang pagtakbo ng agent.
</Step>
</Steps>
