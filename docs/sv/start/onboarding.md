---
summary: "Introduktionsflöde vid första start för OpenClaw (macOS-app)"
read_when:
  - Utformning av macOS-introduktionsassistenten
  - Implementering av autentisering eller identitetskonfiguration
title: "Introduktion (macOS-app)"
sidebarTitle: "Onboarding: macOS App"
---

# Introduktion (macOS-app)

Denna doc beskriver det **aktuella** första körda onboardingflödet. Målet är en
smidig ”dag 0” upplevelse: välj var Gateway går, anslut auth, kör
-guiden och låt agenten bootstrap själv.

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
<Frame caption="Läs säkerhetsmeddelandet som visas och fatta beslut därefter">
<img src="/assets/macos-onboarding/03-security-notice.png" alt="" />
</Frame>
</Step>
<Step title="Local vs Remote">
<Frame>
<img src="/assets/macos-onboarding/04-choose-gateway.png" alt="" />
</Frame>

Var körs **Gateway**?

- **Den här Macen (endast lokalt):** introduktionen kan köra OAuth-flöden och skriva autentiseringsuppgifter lokalt.
- **Fjärr (över SSH/Tailnet):** introduktionen kör **inte** OAuth lokalt; autentiseringsuppgifter måste finnas på gateway-värden.
- **Konfigurera senare:** hoppa över konfigureringen och lämna appen okonfigurerad.

<Tip>
**Gateway auth tip:**
- Guiden genererar nu en **token** även för loopback, så lokala WS-klienter måste autentisera.
- Om du inaktiverar auth, någon lokal process kan ansluta; Använd det endast på fullt betrodda maskiner.
- Använd en **token** för åtkomst till flera maskiner eller icke-loopback bindningar.
</Tip>
</Step>
<Step title="Permissions">
<Frame caption="Välj vilka behörigheter du vill ge OpenClaw">
<img src="/assets/macos-onboarding/05-permissions.png" alt="" />
</Frame>

Introduktionen begär TCC-behörigheter som behövs för:

- Automation (AppleScript)
- Notiser
- Hjälpmedel
- Skärminspelning
- Mikrofon
- Taligenkänning
- Kamera
- Plats

</Step>
<Step title="CLI">
  <Info>Detta steg är valfritt</Info>
  Appen kan installera den globala `openclaw` CLI via npm/pnpm så att
  terminalarbetsflöden och launchd-uppgifter fungerar direkt.
</Step>
<Step title="Onboarding Chat (dedicated session)">
  Efter installationen, öppnar appen en dedikerad onboarding chattsession så att agenten kan
  presentera sig själv och vägleda nästa steg. Detta håller första körningen vägledning separera
  från din normala konversation. Se [Bootstrapping](/start/bootstrapping) för
  vad som händer på gatewayvärden under den första agentkörningen.
</Step>
</Steps>
