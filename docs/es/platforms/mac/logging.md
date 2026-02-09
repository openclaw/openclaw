---
summary: "Registro de OpenClaw: archivo de diagnóstico rotativo + banderas de privacidad del registro unificado"
read_when:
  - Capturar registros de macOS o investigar el registro de datos privados
  - Depurar problemas del ciclo de vida de activación/ sesión de voz
title: "Registro en macOS"
---

# Registro (macOS)

## Archivo de registro de diagnóstico rotativo (panel Debug)

OpenClaw enruta los registros de la app de macOS a través de swift-log (registro unificado de forma predeterminada) y puede escribir un archivo de registro local y rotativo en disco cuando necesita una captura duradera.

- Verborrea: **panel Debug → Logs → App logging → Verbosity**
- Habilitar: **panel Debug → Logs → App logging → “Write rolling diagnostics log (JSONL)”**
- Ubicación: `~/Library/Logs/OpenClaw/diagnostics.jsonl` (rota automáticamente; los archivos antiguos tienen el sufijo `.1`, `.2`, …)
- Borrar: **panel Debug → Logs → App logging → “Clear”**

Notas:

- Esto está **desactivado de forma predeterminada**. Habilítelo solo mientras esté depurando activamente.
- Trate el archivo como sensible; no lo comparta sin revisarlo.

## Datos privados del registro unificado en macOS

El registro unificado redacta la mayoría de las cargas útiles a menos que un subsistema opte por `privacy -off`. Según el artículo de Peter sobre las [triquiñuelas de privacidad del registro en macOS](https://steipete.me/posts/2025/logging-privacy-shenanigans) (2025), esto se controla mediante un plist en `/Library/Preferences/Logging/Subsystems/` identificado por el nombre del subsistema. Solo las nuevas entradas de registro adoptan la bandera, así que habilítela antes de reproducir un problema.

## Habilitar para OpenClaw (`bot.molt`)

- Escriba primero el plist en un archivo temporal y luego instálelo de forma atómica como root:

```bash
cat <<'EOF' >/tmp/bot.molt.plist
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>DEFAULT-OPTIONS</key>
    <dict>
        <key>Enable-Private-Data</key>
        <true/>
    </dict>
</dict>
</plist>
EOF
sudo install -m 644 -o root -g wheel /tmp/bot.molt.plist /Library/Preferences/Logging/Subsystems/bot.molt.plist
```

- No se requiere reinicio; logd detecta el archivo rápidamente, pero solo las nuevas líneas de registro incluirán cargas privadas.
- Vea la salida más detallada con el ayudante existente, por ejemplo `./scripts/clawlog.sh --category WebChat --last 5m`.

## Deshabilitar después de depurar

- Elimine la anulación: `sudo rm /Library/Preferences/Logging/Subsystems/bot.molt.plist`.
- Opcionalmente ejecute `sudo log config --reload` para forzar a logd a eliminar la anulación de inmediato.
- Recuerde que esta superficie puede incluir números de teléfono y cuerpos de mensajes; mantenga el plist en su lugar solo mientras necesite activamente el detalle adicional.
