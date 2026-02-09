---
summary: "Aplikacja węzła iOS: połączenie z Gateway, parowanie, canvas i rozwiązywanie problemów"
read_when:
  - Parowanie lub ponowne łączenie węzła iOS
  - Uruchamianie aplikacji iOS ze źródeł
  - Debugowanie wykrywania Gateway lub poleceń canvas
title: "Aplikacja iOS"
---

# Aplikacja iOS (Węzeł)

Dostępność: wewnętrzna wersja preview. Aplikacja iOS nie jest jeszcze publicznie dystrybuowana.

## Co robi

- Łączy się z Gateway przez WebSocket (LAN lub tailnet).
- Udostępnia możliwości węzła: Canvas, zrzut ekranu, przechwytywanie z kamery, lokalizacja, tryb rozmowy, wybudzanie głosem.
- Odbiera polecenia `node.invoke` i raportuje zdarzenia stanu węzła.

## Wymagania

- Gateway uruchomiony na innym urządzeniu (macOS, Linux lub Windows przez WSL2).
- Ścieżka sieciowa:
  - Ta sama sieć LAN przez Bonjour, **lub**
  - Tailnet przez unicast DNS-SD (przykładowa domena: `openclaw.internal.`), **lub**
  - Ręczny host/port (tryb awaryjny).

## Szybki start (parowanie + połączenie)

1. Uruchom Gateway:

```bash
openclaw gateway --port 18789
```

2. W aplikacji iOS otwórz Ustawienia i wybierz wykryty gateway (lub włącz Ręczny host i wprowadź host/port).

3. Zatwierdź żądanie parowania na hoście Gateway:

```bash
openclaw nodes pending
openclaw nodes approve <requestId>
```

4. Zweryfikuj połączenie:

```bash
openclaw nodes status
openclaw gateway call node.list --params "{}"
```

## Ścieżki wykrywania

### Bonjour (LAN)

Gateway ogłasza `_openclaw-gw._tcp` na `local.`. Aplikacja iOS automatycznie je wyświetla.

### Tailnet (między sieciami)

Jeśli mDNS jest blokowane, użyj strefy unicast DNS-SD (wybierz domenę; przykład: `openclaw.internal.`) oraz Tailscale split DNS.
Zobacz [Bonjour](/gateway/bonjour) dla przykładu CoreDNS.

### Ręczny host/port

W Ustawieniach włącz **Ręczny host** i wprowadź host gateway + port (domyślnie `18789`).

## Canvas + A2UI

Węzeł iOS renderuje canvas WKWebView. Użyj `node.invoke`, aby nim sterować:

```bash
openclaw nodes invoke --node "iOS Node" --command canvas.navigate --params '{"url":"http://<gateway-host>:18793/__openclaw__/canvas/"}'
```

Uwagi:

- Host canvas Gateway serwuje `/__openclaw__/canvas/` oraz `/__openclaw__/a2ui/`.
- Węzeł iOS automatycznie przechodzi do A2UI po połączeniu, gdy ogłoszony jest adres URL hosta canvas.
- Wróć do wbudowanego szkieletu za pomocą `canvas.navigate` oraz `{"url":""}`.

### Eval / zrzut canvas

```bash
openclaw nodes invoke --node "iOS Node" --command canvas.eval --params '{"javaScript":"(() => { const {ctx} = window.__openclaw; ctx.clearRect(0,0,innerWidth,innerHeight); ctx.lineWidth=6; ctx.strokeStyle=\"#ff2d55\"; ctx.beginPath(); ctx.moveTo(40,40); ctx.lineTo(innerWidth-40, innerHeight-40); ctx.stroke(); return \"ok\"; })()"}'
```

```bash
openclaw nodes invoke --node "iOS Node" --command canvas.snapshot --params '{"maxWidth":900,"format":"jpeg"}'
```

## Wybudzanie głosem + tryb rozmowy

- Wybudzanie głosem i tryb rozmowy są dostępne w Ustawieniach.
- iOS może wstrzymywać dźwięk w tle; traktuj funkcje głosowe jako „best‑effort”, gdy aplikacja nie jest aktywna.

## Typowe błędy

- `NODE_BACKGROUND_UNAVAILABLE`: przenieś aplikację iOS na pierwszy plan (polecenia canvas/kamery/ekranu tego wymagają).
- `A2UI_HOST_NOT_CONFIGURED`: Gateway nie ogłosił adresu URL hosta canvas; sprawdź `canvasHost` w [Konfiguracji Gateway](/gateway/configuration).
- Monit parowania nigdy się nie pojawia: uruchom `openclaw nodes pending` i zatwierdź ręcznie.
- Ponowne łączenie nie działa po reinstalacji: token parowania w Pęku kluczy został wyczyszczony; sparuj węzeł ponownie.

## Powiązana dokumentacja

- [Parowanie](/gateway/pairing)
- [Wykrywanie](/gateway/discovery)
- [Bonjour](/gateway/bonjour)
