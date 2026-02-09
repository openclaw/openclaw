---
summary: "OAuth w OpenClaw: wymiana tokenów, przechowywanie i wzorce wielokontowe"
read_when:
  - Chcesz zrozumieć OAuth w OpenClaw od początku do końca
  - Napotykasz problemy z unieważnianiem tokenów / wylogowaniem
  - Chcesz użyć przepływów uwierzytelniania setup-token lub OAuth
  - Chcesz korzystać z wielu kont lub routingu profili
title: "OAuth"
---

# OAuth

OpenClaw obsługuje „subscription auth” przez OAuth dla dostawców, którzy je oferują (w szczególności **OpenAI Codex (ChatGPT OAuth)**). W przypadku subskrypcji Anthropic użyj przepływu **setup-token**. Ta strona wyjaśnia:

- jak działa **wymiana tokenów** OAuth (PKCE)
- gdzie tokeny są **przechowywane** (i dlaczego)
- jak obsługiwać **wiele kont** (profile + nadpisania per sesja)

OpenClaw obsługuje także **wtyczki dostawców**, które dostarczają własne przepływy OAuth lub kluczy API. Uruchamiaj je przez:

```bash
openclaw models auth login --provider <id>
```

## Token sink (dlaczego istnieje)

Dostawcy OAuth często wystawiają **nowy token odświeżania** podczas przepływów logowania/odświeżania. Niektórzy dostawcy (lub klienci OAuth) mogą unieważniać starsze tokeny odświeżania, gdy dla tego samego użytkownika/aplikacji zostanie wydany nowy.

Praktyczny objaw:

- logujesz się przez OpenClaw _oraz_ przez Claude Code / Codex CLI → jeden z nich losowo zostaje później „wylogowany”

Aby to ograniczyć, OpenClaw traktuje `auth-profiles.json` jako **token sink**:

- środowisko wykonawcze odczytuje poświadczenia z **jednego miejsca**
- możemy utrzymywać wiele profili i deterministycznie je routować

## Przechowywanie (gdzie są tokeny)

Sekrety są przechowywane **per agent**:

- Profile uwierzytelniania (OAuth + klucze API): `~/.openclaw/agents/<agentId>/agent/auth-profiles.json`
- Pamięć podręczna środowiska wykonawczego (zarządzana automatycznie; nie edytuj): `~/.openclaw/agents/<agentId>/agent/auth.json`

Plik dziedziczony tylko do importu (nadal obsługiwany, ale nie jest głównym magazynem):

- `~/.openclaw/credentials/oauth.json` (importowany do `auth-profiles.json` przy pierwszym użyciu)

Wszystkie powyższe respektują także `$OPENCLAW_STATE_DIR` (nadpisanie katalogu stanu). Pełne odniesienie: [/gateway/configuration](/gateway/configuration#auth-storage-oauth--api-keys)

## Anthropic setup-token (uwierzytelnianie subskrypcyjne)

Uruchom `claude setup-token` na dowolnej maszynie, a następnie wklej go do OpenClaw:

```bash
openclaw models auth setup-token --provider anthropic
```

Jeśli wygenerowałeś token gdzie indziej, wklej go ręcznie:

```bash
openclaw models auth paste-token --provider anthropic
```

Weryfikacja:

```bash
openclaw models status
```

## Wymiana OAuth (jak działa logowanie)

Interaktywne przepływy logowania OpenClaw są zaimplementowane w `@mariozechner/pi-ai` i podłączone do kreatorów/poleceń.

### Anthropic (Claude Pro/Max) setup-token

Kształt przepływu:

1. uruchom `claude setup-token`
2. wklej token do OpenClaw
3. zapisz jako profil uwierzytelniania tokenem (bez odświeżania)

Ścieżka kreatora to `openclaw onboard` → wybór uwierzytelniania `setup-token` (Anthropic).

### OpenAI Codex (ChatGPT OAuth)

Kształt przepływu (PKCE):

1. wygeneruj weryfikator/wyzwanie PKCE + losowy `state`
2. otwórz `https://auth.openai.com/oauth/authorize?...`
3. spróbuj przechwycić callback na `http://127.0.0.1:1455/auth/callback`
4. jeśli callback nie może się zbindować (lub jesteś zdalnie/headless), wklej URL przekierowania/kod
5. wymień w `https://auth.openai.com/oauth/token`
6. wyodrębnij `accountId` z tokenu dostępu i zapisz `{ access, refresh, expires, accountId }`

Ścieżka kreatora to `openclaw onboard` → wybór uwierzytelniania `openai-codex`.

## Odświeżanie + wygaśnięcie

Profile przechowują znacznik czasu `expires`.

W czasie działania:

- jeśli `expires` jest w przyszłości → użyj zapisanego tokenu dostępu
- jeśli wygasł → odśwież (pod blokadą pliku) i nadpisz zapisane poświadczenia

Przepływ odświeżania jest automatyczny; zazwyczaj nie trzeba zarządzać tokenami ręcznie.

## Wiele kont (profile) + routing

Dwa wzorce:

### 1. Zalecane: oddzielni agenci

Jeśli chcesz, aby „prywatne” i „służbowe” nigdy się nie stykały, użyj izolowanych agentów (oddzielne sesje + poświadczenia + obszar roboczy):

```bash
openclaw agents add work
openclaw agents add personal
```

Następnie skonfiguruj uwierzytelnianie per agent (kreator) i routuj czaty do właściwego agenta.

### 2. Zaawansowane: wiele profili w jednym agencie

`auth-profiles.json` obsługuje wiele identyfikatorów profili dla tego samego dostawcy.

Wybór używanego profilu:

- globalnie przez kolejność konfiguracji (`auth.order`)
- per sesja przez `/model ...@<profileId>`

Przykład (nadpisanie sesji):

- `/model Opus@anthropic:work`

Jak sprawdzić, jakie identyfikatory profili istnieją:

- `openclaw channels list --json` (pokazuje `auth[]`)

Powiązana dokumentacja:

- [/concepts/model-failover](/concepts/model-failover) (rotacja + reguły cooldown)
- [/tools/slash-commands](/tools/slash-commands) (powierzchnia poleceń)
