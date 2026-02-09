---
summary: "Onboarding-flow ved første kørsel for OpenClaw (macOS-app)"
read_when:
  - Design af macOS-onboardingassistenten
  - Implementering af autentificering eller identitetsopsætning
title: "Onboarding (macOS-app)"
sidebarTitle: "Onboarding: macOS App"
---

# Onboarding (macOS-app)

Denne doc beskriver den **nuværende** første rundede onboarding-flow. Målet er en
glat “dag 0” oplevelse: Vælg hvor Gateway kører, forbind auth, kør
-guiden, og lad agenten bootstrap selv.

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
<Frame caption="Læs den viste sikkerhedsmeddelelse og beslut derefter">
<img src="/assets/macos-onboarding/03-security-notice.png" alt="" />
</Frame>
</Step>
<Step title="Local vs Remote">
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
**Gateway auth tip:**
- Guiden genererer nu en **token** selv for loopback, så lokale WS klienter skal godkende.
- Hvis du deaktiverer auth, enhver lokal proces kan tilslutte; bruge det kun på fuldt betroede maskiner.
- Brug en **token** til multimaskine-adgang eller ikke-loopback bindinger.
</Tip>
</Step>
<Step title="Permissions">
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
<Step title="Onboarding Chat (dedicated session)">
  Efter opsætning åbner app'en en dedikeret onboarding chat session, så agenten kan
  introducere sig selv og guide næste trin. Dette holder først-run vejledning adskilt
  fra din normale samtale. Se [Bootstrapping](/start/bootstrapping) for
  hvad der sker på gatewayværten under den første agent kørsel.
</Step>
</Steps>
