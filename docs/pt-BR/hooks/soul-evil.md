---
summary: "Hook SOUL Evil (troca SOUL.md por SOUL_EVIL.md)"
read_when:
  - Você quer habilitar ou ajustar o hook SOUL Evil
  - Você quer uma janela de purge ou troca de persona por chance aleatória
title: "Hook SOUL Evil"
---

# Hook SOUL Evil

O hook SOUL Evil troca o conteúdo **injetado** `SOUL.md` por `SOUL_EVIL.md` durante
uma janela de purge ou por chance aleatória. Ele **não** modifica arquivos no disco.

## Como funciona

Quando `agent:bootstrap` é executado, o hook pode substituir o conteúdo `SOUL.md` na memória
antes que o prompt do sistema seja montado. Se `SOUL_EVIL.md` estiver ausente ou vazio,
o OpenClaw registra um aviso e mantém o `SOUL.md` normal.

Execuções de sub-agentes **não** incluem `SOUL.md` em seus arquivos de bootstrap, portanto este hook
não tem efeito em sub-agentes.

## Habilitar

```bash
openclaw hooks enable soul-evil
```

Em seguida, defina a configuração:

```json
{
  "hooks": {
    "internal": {
      "enabled": true,
      "entries": {
        "soul-evil": {
          "enabled": true,
          "file": "SOUL_EVIL.md",
          "chance": 0.1,
          "purge": { "at": "21:00", "duration": "15m" }
        }
      }
    }
  }
}
```

Crie `SOUL_EVIL.md` na raiz do workspace do agente (ao lado de `SOUL.md`).

## Opções

- `file` (string): nome alternativo do arquivo SOUL (padrão: `SOUL_EVIL.md`)
- `chance` (número 0–1): chance aleatória por execução de usar `SOUL_EVIL.md`
- `purge.at` (HH:mm): início diário do purge (relógio de 24 horas)
- `purge.duration` (duração): duração da janela (ex.: `30s`, `10m`, `1h`)

**Precedência:** a janela de purge tem prioridade sobre a chance.

**Fuso horário:** usa `agents.defaults.userTimezone` quando definido; caso contrário, o fuso horário do host.

## Notas

- Nenhum arquivo é escrito ou modificado no disco.
- Se `SOUL.md` não estiver na lista de bootstrap, o hook não faz nada.

## Veja também

- [Hooks](/automation/hooks)
