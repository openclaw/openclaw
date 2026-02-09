---
summary: "Rozszerzenie Chrome: pozwól OpenClaw sterować Twoją istniejącą kartą Chrome"
read_when:
  - Chcesz, aby agent sterował istniejącą kartą Chrome (przycisk na pasku narzędzi)
  - Potrzebujesz zdalnego Gateway + lokalnej automatyzacji przeglądarki przez Tailscale
  - Chcesz zrozumieć implikacje bezpieczeństwa przejęcia przeglądarki
title: "Rozszerzenie Chrome"
---

# Rozszerzenie Chrome (przekaźnik przeglądarki)

Rozszerzenie OpenClaw dla Chrome pozwala agentowi sterować **Twoimi istniejącymi kartami Chrome** (zwykłe okno Chrome), zamiast uruchamiać oddzielny profil Chrome zarządzany przez OpenClaw.

Podłączanie/odłączanie odbywa się za pomocą **jednego przycisku na pasku narzędzi Chrome**.

## Czym to jest (koncepcja)

Są trzy elementy:

- **Usługa sterowania przeglądarką** (Gateway lub węzeł): API, które wywołuje agent/narzędzie (przez Gateway)
- **Lokalny serwer przekaźnika** (loopback CDP): most między serwerem sterowania a rozszerzeniem (`http://127.0.0.1:18792` domyślnie)
- **Rozszerzenie Chrome MV3**: dołącza do aktywnej karty za pomocą `chrome.debugger` i przesyła komunikaty CDP do przekaźnika

Następnie OpenClaw steruje dołączoną kartą przez standardową powierzchnię narzędzia `browser` (z wyborem odpowiedniego profilu).

## Instalacja / wczytanie (unpacked)

1. Zainstaluj rozszerzenie w stabilnej lokalnej ścieżce:

```bash
openclaw browser extension install
```

2. Wyświetl ścieżkę katalogu zainstalowanego rozszerzenia:

```bash
openclaw browser extension path
```

3. Chrome → `chrome://extensions`

- Włącz „Tryb dewelopera”
- „Wczytaj rozpakowane” → wybierz katalog wydrukowany powyżej

4. Przypnij rozszerzenie.

## Aktualizacje (bez kroku budowania)

Rozszerzenie jest dostarczane w ramach wydania OpenClaw (pakiet npm) jako pliki statyczne. Nie ma osobnego kroku „build”.

Po aktualizacji OpenClaw:

- Uruchom ponownie `openclaw browser extension install`, aby odświeżyć zainstalowane pliki w katalogu stanu OpenClaw.
- Chrome → `chrome://extensions` → kliknij „Reload” przy rozszerzeniu.

## Użycie (bez dodatkowej konfiguracji)

OpenClaw zawiera wbudowany profil przeglądarki o nazwie `chrome`, który wskazuje na przekaźnik rozszerzenia na domyślnym porcie.

Użycie:

- CLI: `openclaw browser --browser-profile chrome tabs`
- Narzędzie agenta: `browser` z `profile="chrome"`

Jeśli chcesz inną nazwę lub inny port przekaźnika, utwórz własny profil:

```bash
openclaw browser create-profile \
  --name my-chrome \
  --driver extension \
  --cdp-url http://127.0.0.1:18792 \
  --color "#00AA00"
```

## Dołączanie / odłączanie (przycisk na pasku narzędzi)

- Otwórz kartę, którą chcesz, aby OpenClaw kontrolował.
- Kliknij ikonę rozszerzenia.
  - Odznaka pokazuje `ON` po dołączeniu.
- Kliknij ponownie, aby odłączyć.

## Która karta kontrolu?

- **Nie** kontroluje automatycznie „dowolnej karty, na którą patrzysz”.
- Kontroluje **tylko kartę (karty), które jawnie dołączysz**, klikając przycisk na pasku narzędzi.
- Aby przełączyć: otwórz inną kartę i kliknij tam ikonę rozszerzenia.

## Odznaka + typowe błędy

- `ON`: dołączona; OpenClaw może sterować tą kartą.
- `…`: łączenie z lokalnym przekaźnikiem.
- `!`: przekaźnik nieosiągalny (najczęściej: serwer przekaźnika przeglądarki nie działa na tej maszynie).

Jeśli widzisz `!`:

- Upewnij się, że Gateway działa lokalnie (konfiguracja domyślna) albo uruchom host węzła na tej maszynie, jeśli Gateway działa gdzie indziej.
- Otwórz stronę Opcje rozszerzenia; pokazuje, czy przekaźnik jest osiągalny.

## Zdalny Gateway (użyj hosta węzła)

### Lokalny Gateway (ta sama maszyna co Chrome) — zwykle **bez dodatkowych kroków**

Jeśli Gateway działa na tej samej maszynie co Chrome, uruchamia usługę sterowania przeglądarką na local loopback
i automatycznie startuje serwer przekaźnika. Rozszerzenie komunikuje się z lokalnym przekaźnikiem; wywołania CLI/narzędzi trafiają do Gateway.

### Zdalny Gateway (Gateway działa gdzie indziej) — **uruchom host węzła**

Jeśli Gateway działa na innej maszynie, uruchom host węzła na maszynie z Chrome.
Gateway będzie proxy’ował akcje przeglądarki do tego węzła; rozszerzenie + przekaźnik pozostają lokalnie na maszynie przeglądarki.

Jeśli podłączonych jest wiele węzłów, przypnij jeden za pomocą `gateway.nodes.browser.node` lub ustaw `gateway.nodes.browser.mode`.

## Sandboxing (kontenery narzędzi)

Jeśli sesja agenta jest sandboxowana (`agents.defaults.sandbox.mode != "off"`), narzędzie `browser` może być ograniczone:

- Domyślnie sesje sandboxowane często celują w **przeglądarkę sandbox** (`target="sandbox"`), a nie w Chrome hosta.
- Przejęcie przez przekaźnik rozszerzenia Chrome wymaga sterowania serwerem sterowania przeglądarką **hosta**.

Opcje:

- Najprościej: użyj rozszerzenia z sesji/agenta **niesandboxowanej**.
- Albo zezwól na sterowanie przeglądarką hosta dla sesji sandboxowanych:

```json5
{
  agents: {
    defaults: {
      sandbox: {
        browser: {
          allowHostControl: true,
        },
      },
    },
  },
}
```

Następnie upewnij się, że narzędzie nie jest blokowane przez politykę narzędzi oraz (jeśli potrzeba) wywołaj `browser` z `target="host"`.

Debugowanie: `openclaw sandbox explain`

## Wskazówki dotyczące dostępu zdalnego

- Trzymaj Gateway i host węzła w tej samej tailnet; unikaj wystawiania portów przekaźnika do LAN lub publicznego Internetu.
- Paruj węzły świadomie; wyłącz trasowanie proxy przeglądarki, jeśli nie chcesz zdalnego sterowania (`gateway.nodes.browser.mode="off"`).

## Jak działa „ścieżka rozszerzenia”

`openclaw browser extension path` drukuje **zainstalowany** katalog na dysku zawierający pliki rozszerzenia.

CLI celowo **nie** drukuje ścieżki `node_modules`. Zawsze najpierw uruchom `openclaw browser extension install`, aby skopiować rozszerzenie do stabilnej lokalizacji w katalogu stanu OpenClaw.

Jeśli przeniesiesz lub usuniesz ten katalog instalacyjny, Chrome oznaczy rozszerzenie jako uszkodzone, dopóki nie wczytasz go ponownie z poprawnej ścieżki.

## Implikacje bezpieczeństwa (przeczytaj)

To jest potężne i ryzykowne. Traktuj to jak danie modelowi „rąk na Twojej przeglądarce”.

- Rozszerzenie używa interfejsu debuggera Chrome (`chrome.debugger`). Po dołączeniu model może:
  - klikać/pisać/nawigować w tej karcie
  - czytać zawartość strony
  - uzyskiwać dostęp do wszystkiego, do czego ma dostęp zalogowana sesja tej karty
- **To nie jest izolowane** jak dedykowany profil zarządzany przez OpenClaw.
  - Jeśli dołączysz do profilu/karty używanej na co dzień, przyznajesz dostęp do tego stanu konta.

Zalecenia:

- Preferuj dedykowany profil Chrome (oddzielny od prywatnego przeglądania) do użycia przekaźnika rozszerzenia.
- Trzymaj Gateway i wszelkie hosty węzłów wyłącznie w tailnet; polegaj na uwierzytelnianiu Gateway + parowaniu węzłów.
- Unikaj wystawiania portów przekaźnika w LAN (`0.0.0.0`) i unikaj Funnel (publicznego).
- Przekaźnik blokuje pochodzenia inne niż rozszerzenie i wymaga wewnętrznego tokena uwierzytelniania dla klientów CDP.

Powiązane:

- Przegląd narzędzia przeglądarki: [Browser](/tools/browser)
- Audyt bezpieczeństwa: [Security](/gateway/security)
- Konfiguracja Tailscale: [Tailscale](/gateway/tailscale)
