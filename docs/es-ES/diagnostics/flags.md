---
summary: "Banderas de diagnóstico para registros de depuración específicos"
read_when:
  - Necesitas registros de depuración específicos sin elevar los niveles globales de registro
  - Necesitas capturar registros específicos de subsistemas para soporte
title: "Banderas de Diagnóstico"
---

# Banderas de Diagnóstico

Las banderas de diagnóstico te permiten habilitar registros de depuración específicos sin activar el registro detallado en todas partes. Las banderas son opcionales y no tienen efecto a menos que un subsistema las verifique.

## Cómo funciona

- Las banderas son cadenas de texto (no distinguen mayúsculas/minúsculas).
- Puedes habilitar banderas en la configuración o mediante una anulación de variable de entorno.
- Se admiten comodines:
  - `telegram.*` coincide con `telegram.http`
  - `*` habilita todas las banderas

## Habilitar mediante configuración

```json
{
  "diagnostics": {
    "flags": ["telegram.http"]
  }
}
```

Múltiples banderas:

```json
{
  "diagnostics": {
    "flags": ["telegram.http", "gateway.*"]
  }
}
```

Reinicia el gateway después de cambiar las banderas.

## Anulación mediante variable de entorno (una sola vez)

```bash
OPENCLAW_DIAGNOSTICS=telegram.http,telegram.payload
```

Deshabilitar todas las banderas:

```bash
OPENCLAW_DIAGNOSTICS=0
```

## Dónde van los registros

Las banderas emiten registros en el archivo de registro de diagnóstico estándar. Por defecto:

```
/tmp/openclaw/openclaw-YYYY-MM-DD.log
```

Si estableces `logging.file`, usa esa ruta en su lugar. Los registros están en formato JSONL (un objeto JSON por línea). La redacción aún se aplica según `logging.redactSensitive`.

## Extraer registros

Elegir el archivo de registro más reciente:

```bash
ls -t /tmp/openclaw/openclaw-*.log | head -n 1
```

Filtrar para diagnósticos HTTP de Telegram:

```bash
rg "telegram http error" /tmp/openclaw/openclaw-*.log
```

O seguir en tiempo real mientras reproduces:

```bash
tail -f /tmp/openclaw/openclaw-$(date +%F).log | rg "telegram http error"
```

Para gateways remotos, también puedes usar `openclaw logs --follow` (ver [/es-ES/cli/logs](/es-ES/cli/logs)).

## Notas

- Si `logging.level` está establecido más alto que `warn`, estos registros pueden ser suprimidos. El `info` predeterminado está bien.
- Las banderas son seguras de dejar habilitadas; solo afectan el volumen de registros para el subsistema específico.
- Usa [/es-ES/logging](/es-ES/logging) para cambiar destinos de registros, niveles y redacción.
