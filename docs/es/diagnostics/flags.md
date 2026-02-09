---
summary: "Indicadores de diagnóstico para registros de depuración dirigidos"
read_when:
  - Necesita registros de depuración dirigidos sin aumentar los niveles de registro globales
  - Necesita capturar registros específicos de subsistemas para soporte
title: "Indicadores de diagnóstico"
---

# Indicadores de diagnóstico

Los indicadores de diagnóstico le permiten habilitar registros de depuración dirigidos sin activar el registro detallado en todas partes. Los indicadores son opcionales y no tienen efecto a menos que un subsistema los consulte.

## Cómo funciona

- Los indicadores son cadenas (no distinguen entre mayúsculas y minúsculas).
- Puede habilitar indicadores en la configuración o mediante una anulación por variable de entorno.
- Comodos soportados:
  - `telegram.*` coincide con `telegram.http`
  - `*` habilita todos los indicadores

## Habilitar mediante configuración

```json
{
  "diagnostics": {
    "flags": ["telegram.http"]
  }
}
```

Varios indicadores:

```json
{
  "diagnostics": {
    "flags": ["telegram.http", "gateway.*"]
  }
}
```

Reinicie el Gateway después de cambiar los indicadores.

## Anulación de Env (une-off)

```bash
OPENCLAW_DIAGNOSTICS=telegram.http,telegram.payload
```

Deshabilitar todos los indicadores:

```bash
OPENCLAW_DIAGNOSTICS=0
```

## Dónde van los registros

Los indicadores emiten registros en el archivo de diagnóstico estándar. De forma predeterminada:

```
/tmp/openclaw/openclaw-YYYY-MM-DD.log
```

Si configura `logging.file`, use esa ruta en su lugar. Los registros están en JSONL (un objeto JSON por línea). La redacción sigue aplicándose según `logging.redactSensitive`.

## Extraer registros

Elija el archivo de registro más reciente:

```bash
ls -t /tmp/openclaw/openclaw-*.log | head -n 1
```

Filtre diagnósticos HTTP de Telegram:

```bash
rg "telegram http error" /tmp/openclaw/openclaw-*.log
```

O haga tail mientras reproduce el problema:

```bash
tail -f /tmp/openclaw/openclaw-$(date +%F).log | rg "telegram http error"
```

Para Gateways remotos, también puede usar `openclaw logs --follow` (consulte [/cli/logs](/cli/logs)).

## Notas

- Si `logging.level` está configurado más alto que `warn`, estos registros pueden suprimirse. El valor predeterminado `info` es adecuado.
- Es seguro dejar los indicadores habilitados; solo afectan el volumen de registros del subsistema específico.
- Use [/logging](/logging) para cambiar los destinos de los registros, los niveles y la redacción.
