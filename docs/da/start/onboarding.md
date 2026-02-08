---
summary: "Onboarding-flow ved første kørsel for OpenClaw (macOS-app)"
read_when:
  - Design af macOS-onboardingassistenten
  - Implementering af autentificering eller identitetsopsætning
title: "Onboarding (macOS-app)"
sidebarTitle: "Onboarding: macOS App"
x-i18n:
  source_path: start/onboarding.md
  source_hash: 45f912067527158f
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:50:42Z
---

# Onboarding (macOS-app)

Dette dokument beskriver den **nuværende** onboarding ved første kørsel. Målet er
en glidende “dag 0”-oplevelse: vælg hvor Gateway kører, forbind autentificering,
kør opsætningsguiden, og lad agenten bootstrappe sig selv.

<Steps>
<Step title="Godkend macOS-advarsel">
<Frame>
<img src="/assets/macos-onboarding/01-macos-warning.jpeg" alt="" />
</Frame>
</Step>
<Step title="Godkend at finde lokale netværk">
<Frame>
<img src="/assets/macos-onboarding/02-local-networks.jpeg" alt="" />
</Frame>
</Step>
<Step title="Velkomst og sikkerhedsmeddelelse">
<Frame caption="Læs den viste sikkerhedsmeddelelse og beslut derefter">
<img src="/assets/macos-onboarding/03-security-notice.png" alt="" />
</Frame>
</Step>
<Step title="Lokal vs. fjern">
<Frame>
<img src="/assets/macos-onboarding/04-choose-gateway.png" alt="" />
</Frame>

Hvor kører **Gateway**?

- **Denne Mac (kun lokalt):** onboarding kan køre OAuth-flows og skrive legitimationsoplysninger
  lokalt.
- **Fjern (over SSH/Tailnet):** onboarding kører **ikke** OAuth lokalt;
  legitimationsoplysninger skal findes på gateway-værten.
- **Konfigurer senere:** spring opsætning over og lad appen være ukonfigureret.

<Tip>
**Tip til Gateway-autentificering:**
- Opsætningsguiden genererer nu et **token** selv for loopback, så lokale WS-klienter skal autentificere.
- Hvis du deaktiverer autentificering, kan enhver lokal proces forbinde; brug det kun på fuldt betroede maskiner.
- Brug et **token** til adgang fra flere maskiner eller ikke-loopback-bindinger.
</Tip>
</Step>
<Step title="Tilladelser">
<Frame caption="Vælg hvilke tilladelser du vil give OpenClaw">
<img src="/assets/macos-onboarding/05-permissions.png" alt="" />
</Frame>

Onboarding anmoder om TCC-tilladelser, der er nødvendige for:

- Automatisering (AppleScript)
- Notifikationer
- Tilgængelighed
- Skærmoptagelse
- Mikrofon
- Talegenkendelse
- Kamera
- Placering

</Step>
<Step title="CLI">
  <Info>Dette trin er valgfrit</Info>
  Appen kan installere den globale `openclaw` CLI via npm/pnpm, så terminal‑
  workflows og launchd-opgaver virker ud af boksen.
</Step>
<Step title="Onboarding-chat (dedikeret session)">
  Efter opsætning åbner appen en dedikeret onboarding-chat-session, så agenten kan
  introducere sig selv og guide de næste trin. Det holder vejledning ved første
  kørsel adskilt fra din normale samtale. Se [Bootstrapping](/start/bootstrapping)
  for hvad der sker på gateway-værten under den første agentkørsel.
</Step>
</Steps>
