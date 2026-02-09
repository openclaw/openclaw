---
summary: "Obsługa konta osobistego Zalo przez zca-cli (logowanie QR), możliwości i konfiguracja"
read_when:
  - Konfiguracja Zalo Personal dla OpenClaw
  - Debugowanie logowania Zalo Personal lub przepływu wiadomości
title: "Zalo Personal"
---

# Zalo Personal (nieoficjalne)

Status: eksperymentalne. Ta integracja automatyzuje **osobiste konto Zalo** przez `zca-cli`.

> **Ostrzeżenie:** To jest integracja nieoficjalna i może skutkować zawieszeniem lub zablokowaniem konta. Używasz na własne ryzyko.

## Wymagana wtyczka

Zalo Personal jest dostarczane jako wtyczka i nie jest dołączone do instalacji podstawowej.

- Instalacja przez CLI: `openclaw plugins install @openclaw/zalouser`
- Albo z repozytorium źródłowego: `openclaw plugins install ./extensions/zalouser`
- Szczegóły: [Plugins](/tools/plugin)

## Wymaganie wstępne: zca-cli

Maszyna Gateway musi mieć dostępny plik binarny `zca` w `PATH`.

- Weryfikacja: `zca --version`
- Jeśli brak, zainstaluj zca-cli (zob. `extensions/zalouser/README.md` lub dokumentację upstream zca-cli).

## Szybka konfiguracja (dla początkujących)

1. Zainstaluj wtyczkę (zob. powyżej).
2. Zaloguj się (QR, na maszynie Gateway):
   - `openclaw channels login --channel zalouser`
   - Zeskanuj kod QR w terminalu aplikacją mobilną Zalo.
3. Włącz kanał:

```json5
{
  channels: {
    zalouser: {
      enabled: true,
      dmPolicy: "pairing",
    },
  },
}
```

4. Zrestartuj Gateway (lub dokończ onboarding).
5. Dostęp do DM-ów domyślnie wymaga parowania; zatwierdź kod parowania przy pierwszym kontakcie.

## Czym to jest

- Używa `zca listen` do odbierania wiadomości przychodzących.
- Używa `zca msg ...` do wysyłania odpowiedzi (tekst/media/link).
- Zaprojektowane dla przypadków „konta osobistego”, gdy Zalo Bot API nie jest dostępne.

## Nazewnictwo

Identyfikator kanału to `zalouser`, aby jasno wskazać, że automatyzuje **osobiste konto użytkownika Zalo** (nieoficjalnie). `zalo` pozostawiamy zarezerwowane dla potencjalnej przyszłej oficjalnej integracji Zalo API.

## Wyszukiwanie identyfikatorów (katalog)

Użyj CLI katalogu, aby wykryć kontakty/grupy i ich identyfikatory:

```bash
openclaw directory self --channel zalouser
openclaw directory peers list --channel zalouser --query "name"
openclaw directory groups list --channel zalouser --query "work"
```

## Limity

- Tekst wychodzący jest dzielony na fragmenty do ~2000 znaków (limity klienta Zalo).
- Strumieniowanie jest domyślnie zablokowane.

## Kontrola dostępu (DM-y)

`channels.zalouser.dmPolicy` obsługuje: `pairing | allowlist | open | disabled` (domyślnie: `pairing`).
`channels.zalouser.allowFrom` akceptuje identyfikatory użytkowników lub nazwy. Kreator rozwiązuje nazwy do identyfikatorów przez `zca friend find`, gdy to możliwe.

Zatwierdzanie przez:

- `openclaw pairing list zalouser`
- `openclaw pairing approve zalouser <code>`

## Dostęp do grup (opcjonalnie)

- Domyślnie: `channels.zalouser.groupPolicy = "open"` (grupy dozwolone). Użyj `channels.defaults.groupPolicy`, aby nadpisać domyślne ustawienie, gdy jest nieustawione.
- Ogranicz do listy dozwolonych za pomocą:
  - `channels.zalouser.groupPolicy = "allowlist"`
  - `channels.zalouser.groups` (klucze to identyfikatory grup lub nazwy)
- Zablokuj wszystkie grupy: `channels.zalouser.groupPolicy = "disabled"`.
- Kreator konfiguracji może poprosić o listy dozwolonych grup.
- Podczas uruchamiania OpenClaw rozwiązuje nazwy grup/użytkowników w listach dozwolonych do identyfikatorów i zapisuje mapowanie w logach; nierozwiązane wpisy są zachowywane w oryginalnej postaci.

Przykład:

```json5
{
  channels: {
    zalouser: {
      groupPolicy: "allowlist",
      groups: {
        "123456789": { allow: true },
        "Work Chat": { allow: true },
      },
    },
  },
}
```

## Wiele kont

Konta mapują się na profile zca. Przykład:

```json5
{
  channels: {
    zalouser: {
      enabled: true,
      defaultAccount: "default",
      accounts: {
        work: { enabled: true, profile: "work" },
      },
    },
  },
}
```

## Rozwiązywanie problemów

**Nie znaleziono `zca`:**

- Zainstaluj zca-cli i upewnij się, że znajduje się w `PATH` dla procesu Gateway.

**Logowanie nie jest trwałe:**

- `openclaw channels status --probe`
- Ponowne logowanie: `openclaw channels logout --channel zalouser && openclaw channels login --channel zalouser`
