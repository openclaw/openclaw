---
summary: "Proces wdrożenia przy pierwszym uruchomieniu OpenClaw (aplikacja na macOS)"
read_when:
  - Projektowanie asystenta wdrożeniowego macOS
  - Implementowanie uwierzytelniania lub konfiguracji tożsamości
title: "Wdrożenie (aplikacja na macOS)"
sidebarTitle: "Onboarding: macOS App"
---

# Wdrożenie (aplikacja na macOS)

Ten dokument opisuje **aktualny** proces wdrożenia przy pierwszym uruchomieniu. Celem jest płynne doświadczenie „dzień 0”: wybór miejsca uruchomienia Gateway, podłączenie uwierzytelniania, przejście kreatora i pozwolenie agentowi na samodzielne uruchomienie.

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
<Frame caption="Przeczytaj wyświetloną informację o bezpieczeństwie i zdecyduj odpowiednio">
<img src="/assets/macos-onboarding/03-security-notice.png" alt="" />
</Frame>
</Step>
<Step title="Local vs Remote">
<Frame>
<img src="/assets/macos-onboarding/04-choose-gateway.png" alt="" />
</Frame>

Gdzie działa **Gateway**?

- **Ten Mac (tylko lokalnie):** wdrożenie może uruchamiać przepływy OAuth i zapisywać poświadczenia lokalnie.
- **Zdalnie (przez SSH/Tailnet):** wdrożenie **nie** uruchamia OAuth lokalnie; poświadczenia muszą istnieć na hoście gateway.
- **Skonfiguruj później:** pomiń konfigurację i pozostaw aplikację nieskonfigurowaną.

<Tip>
**Wskazówka dotycząca uwierzytelniania Gateway:**
- Kreator generuje teraz **token** nawet dla loopback, więc lokalni klienci WS muszą się uwierzytelniać.
- Jeśli wyłączysz uwierzytelnianie, każdy lokalny proces może się połączyć; używaj tego tylko na w pełni zaufanych maszynach.
- Użyj **tokenu** dla dostępu z wielu maszyn lub dla powiązań innych niż loopback.
</Tip>
</Step>
<Step title="Permissions">
<Frame caption="Wybierz, jakie uprawnienia chcesz przyznać OpenClaw">
<img src="/assets/macos-onboarding/05-permissions.png" alt="" />
</Frame>

Wdrożenie prosi o uprawnienia TCC potrzebne do:

- Automatyzacji (AppleScript)
- Powiadomień
- Dostępności
- Nagrywania ekranu
- Mikrofonu
- Rozpoznawania mowy
- Kamery
- Lokalizacji

</Step>
<Step title="CLI">
  <Info>Ten krok jest opcjonalny</Info>
  Aplikacja może zainstalować globalne CLI `openclaw` przez npm/pnpm, aby
  przepływy pracy w terminalu oraz zadania launchd działały od razu.
</Step>
<Step title="Onboarding Chat (dedicated session)">
  Po zakończeniu konfiguracji aplikacja otwiera dedykowaną sesję czatu wdrożeniowego, aby agent mógł
  się przedstawić i poprowadzić przez kolejne kroki. Pozwala to oddzielić wskazówki przy pierwszym uruchomieniu
  od Twojej zwykłej rozmowy. Zobacz [Bootstrapping](/start/bootstrapping), aby dowiedzieć się,
  co dzieje się na hoście gateway podczas pierwszego uruchomienia agenta.
</Step>
</Steps>
