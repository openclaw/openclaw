---
summary: "Introduktionsflöde vid första start för OpenClaw (macOS-app)"
read_when:
  - Utformning av macOS-introduktionsassistenten
  - Implementering av autentisering eller identitetskonfiguration
title: "Introduktion (macOS-app)"
sidebarTitle: "Onboarding: macOS App"
x-i18n:
  source_path: start/onboarding.md
  source_hash: 45f912067527158f
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T08:18:30Z
---

# Introduktion (macOS-app)

Detta dokument beskriver det **nuvarande** introduktionsflödet vid första start. Målet är en smidig ”dag 0”-upplevelse: välj var Gateway körs, anslut autentisering, kör guiden och låt agenten starta upp sig själv.

<Steps>
<Step title="Godkänn macOS-varning">
<Frame>
<img src="/assets/macos-onboarding/01-macos-warning.jpeg" alt="" />
</Frame>
</Step>
<Step title="Godkänn hitta lokala nätverk">
<Frame>
<img src="/assets/macos-onboarding/02-local-networks.jpeg" alt="" />
</Frame>
</Step>
<Step title="Välkomst- och säkerhetsmeddelande">
<Frame caption="Läs säkerhetsmeddelandet som visas och fatta beslut därefter">
<img src="/assets/macos-onboarding/03-security-notice.png" alt="" />
</Frame>
</Step>
<Step title="Lokal vs fjärr">
<Frame>
<img src="/assets/macos-onboarding/04-choose-gateway.png" alt="" />
</Frame>

Var körs **Gateway**?

- **Den här Macen (endast lokalt):** introduktionen kan köra OAuth-flöden och skriva autentiseringsuppgifter lokalt.
- **Fjärr (över SSH/Tailnet):** introduktionen kör **inte** OAuth lokalt; autentiseringsuppgifter måste finnas på gateway-värden.
- **Konfigurera senare:** hoppa över konfigureringen och lämna appen okonfigurerad.

<Tip>
**Tips om Gateway-autentisering:**
- Guiden genererar nu en **token** även för local loopback, så lokala WS-klienter måste autentisera sig.
- Om du inaktiverar autentisering kan vilken lokal process som helst ansluta; använd det endast på fullt betrodda maskiner.
- Använd en **token** för åtkomst från flera maskiner eller bindningar som inte är loopback.
</Tip>
</Step>
<Step title="Behörigheter">
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
<Step title="Introduktionschatt (dedikerad session)">
  Efter konfigureringen öppnar appen en dedikerad introduktionschatt-session så att agenten kan
  presentera sig och guida nästa steg. Detta håller vägledningen vid första start åtskild
  från dina vanliga konversationer. Se [Bootstrapping](/start/bootstrapping) för
  vad som händer på gateway-värden under den första agentkörningen.
</Step>
</Steps>
