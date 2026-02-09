---
summary: "Hook SOUL Evil (intercambia SOUL.md por SOUL_EVIL.md)"
read_when:
  - Desea habilitar o ajustar el hook SOUL Evil
  - Desea una ventana de purga o un intercambio de persona por probabilidad aleatoria
title: "Hook SOUL Evil"
---

# Hook SOUL Evil

El hook SOUL Evil intercambia el contenido **inyectado** `SOUL.md` por `SOUL_EVIL.md` durante
una ventana de purga o por probabilidad aleatoria. **No** modifica archivos en disco.

## Cómo funciona

Cuando se ejecuta `agent:bootstrap`, el hook puede reemplazar el contenido `SOUL.md` en memoria
antes de que se ensamble el prompt del sistema. Si `SOUL_EVIL.md` falta o está vacío,
OpenClaw registra una advertencia y mantiene el `SOUL.md` normal.

Las ejecuciones de subagentes **no** incluyen `SOUL.md` en sus archivos de arranque, por lo que este hook
no tiene efecto en los subagentes.

## Habilitar

```bash
openclaw hooks enable soul-evil
```

Luego establezca la configuración:

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

Cree `SOUL_EVIL.md` en la raíz del espacio de trabajo del agente (junto a `SOUL.md`).

## Opciones

- `file` (cadena): nombre alternativo del archivo SOUL (predeterminado: `SOUL_EVIL.md`)
- `chance` (número 0–1): probabilidad aleatoria por ejecución para usar `SOUL_EVIL.md`
- `purge.at` (HH:mm): inicio diario de la purga (formato de 24 horas)
- `purge.duration` (duración): longitud de la ventana (p. ej., `30s`, `10m`, `1h`)

**Precedencia:** la ventana de purga prevalece sobre la probabilidad.

**Zona horaria:** usa `agents.defaults.userTimezone` cuando está configurado; de lo contrario, la zona horaria del host.

## Notas

- No se escriben ni modifican archivos en disco.
- Si `SOUL.md` no está en la lista de arranque, el hook no hace nada.

## Ver también

- [Hooks](/automation/hooks)
