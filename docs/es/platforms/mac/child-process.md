---
summary: "Ciclo de vida del Gateway en macOS (launchd)"
read_when:
  - Integración de la app de mac con el ciclo de vida del Gateway
title: "Ciclo de vida del Gateway"
---

# Ciclo de vida del Gateway en macOS

La app de macOS **gestiona el Gateway mediante launchd** de forma predeterminada y no inicia
el Gateway como un proceso hijo. Primero intenta conectarse a un Gateway ya en ejecución
en el puerto configurado; si no hay ninguno accesible, habilita el servicio launchd mediante
la CLI externa `openclaw` (sin runtime integrado). Esto le brinda un inicio automático
confiable al iniciar sesión y reinicio ante fallos.

El modo de proceso hijo (Gateway iniciado directamente por la app) **no se utiliza** hoy.
Si necesita un acoplamiento más estrecho con la UI, ejecute el Gateway manualmente en una terminal.

## Comportamiento predeterminado (launchd)

- La app instala un LaunchAgent por usuario con la etiqueta `bot.molt.gateway`
  (o `bot.molt.<profile>` cuando se usa `--profile`/`OPENCLAW_PROFILE`; se admite el legado `com.openclaw.*`).
- Cuando el modo Local está habilitado, la app garantiza que el LaunchAgent esté cargado y
  inicia el Gateway si es necesario.
- Los registros se escriben en la ruta de logs del Gateway de launchd (visible en Configuración de depuración).

Comandos comunes:

```bash
launchctl kickstart -k gui/$UID/bot.molt.gateway
launchctl bootout gui/$UID/bot.molt.gateway
```

Reemplace la etiqueta por `bot.molt.<profile>` cuando ejecute un perfil con nombre.

## Builds de desarrollo sin firmar

`scripts/restart-mac.sh --no-sign` es para builds locales rápidos cuando no tiene
claves de firma. Para evitar que launchd apunte a un binario de relay sin firmar, realiza lo siguiente:

- Escribe `~/.openclaw/disable-launchagent`.

Las ejecuciones firmadas de `scripts/restart-mac.sh` eliminan esta anulación si el marcador
está presente. Para restablecer manualmente:

```bash
rm ~/.openclaw/disable-launchagent
```

## Modo solo adjuntar

Para forzar que la app de macOS **nunca instale ni gestione launchd**, ejecútela con
`--attach-only` (o `--no-launchd`). Esto establece `~/.openclaw/disable-launchagent`,
por lo que la app solo se adjunta a un Gateway que ya esté en ejecución. Puede alternar el mismo
comportamiento en Configuración de depuración.

## Modo remoto

El modo remoto nunca inicia un Gateway local. La app utiliza un túnel SSH hacia el
host remoto y se conecta a través de ese túnel.

## Por qué preferimos launchd

- Inicio automático al iniciar sesión.
- Semántica integrada de reinicio/KeepAlive.
- Logs y supervisión predecibles.

Si alguna vez se vuelve a necesitar un modo de proceso hijo real, debería documentarse como
un modo separado y explícito solo para desarrollo.
