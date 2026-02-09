---
summary: "Onboardingstroom bij eerste start voor OpenClaw (macOS‑app)"
read_when:
  - Ontwerpen van de macOS-onboardingassistent
  - Implementeren van authenticatie- of identiteitsinstellingen
title: "Onboarding (macOS‑app)"
sidebarTitle: "Onboarding: macOS App"
---

# Onboarding (macOS‑app)

Dit document beschrijft de **huidige** onboardingstroom bij de eerste start. Het doel is een
soepele “dag 0”-ervaring: kies waar de Gateway draait, verbind authenticatie, doorloop de
wizard en laat de agent zichzelf bootstrapen.

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
<Frame caption="Lees de weergegeven beveiligingsmelding en beslis dienovereenkomstig">
<img src="/assets/macos-onboarding/03-security-notice.png" alt="" />
</Frame>
</Step>
<Step title="Local vs Remote">
<Frame>
<img src="/assets/macos-onboarding/04-choose-gateway.png" alt="" />
</Frame>

Waar draait de **Gateway**?

- **Deze Mac (alleen lokaal):** onboarding kan OAuth‑stromen uitvoeren en inloggegevens
  lokaal wegschrijven.
- **Op afstand (via SSH/Tailnet):** onboarding voert **geen** OAuth lokaal uit;
  inloggegevens moeten bestaan op de Gateway-host.
- **Later configureren:** sla de installatie over en laat de app ongeconfigureerd.

<Tip>
**Gateway-authenticatietip:**
- De wizard genereert nu een **token**, zelfs voor local loopback, zodat lokale WS-clients zich moeten authenticeren.
- Als je authenticatie uitschakelt, kan elk lokaal proces verbinding maken; gebruik dit alleen op volledig vertrouwde machines.
- Gebruik een **token** voor toegang vanaf meerdere machines of niet‑loopback‑bindings.
</Tip>
</Step>
<Step title="Permissions">
<Frame caption="Kies welke rechten je aan OpenClaw wilt geven">
<img src="/assets/macos-onboarding/05-permissions.png" alt="" />
</Frame>

Onboarding vraagt TCC-rechten aan die nodig zijn voor:

- Automatisering (AppleScript)
- Meldingen
- Toegankelijkheid
- Schermopname
- Microfoon
- Spraakherkenning
- Camera
- Locatie

</Step>
<Step title="CLI">
  <Info>Deze stap is optioneel</Info>
  De app kan de globale `openclaw` CLI via npm/pnpm installeren zodat terminal‑
  workflows en launchd‑taken direct werken.
</Step>
<Step title="Onboarding Chat (dedicated session)">
  Na de installatie opent de app een speciale onboardingchat‑sessie zodat de agent zich kan
  voorstellen en de volgende stappen kan begeleiden. Dit houdt begeleiding bij de eerste start
  gescheiden van je normale gesprek. Zie [Bootstrapping](/start/bootstrapping) voor
  wat er gebeurt op de Gateway-host tijdens de eerste agentrun.
</Step>
</Steps>
