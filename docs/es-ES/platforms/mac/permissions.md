---
summary: "Persistencia de permisos de macOS (TCC) y requisitos de firma"
read_when:
  - Depurando prompts de permisos de macOS faltantes o atascados
  - Empaquetando o firmando la app de macOS
  - Cambiando IDs de bundle o rutas de instalación de la app
title: "Permisos de macOS"
---

# Permisos de macOS (TCC)

Los otorgamientos de permisos de macOS son frágiles. TCC asocia un otorgamiento de permiso con la firma de código de la app, el identificador del bundle y la ruta en disco. Si alguno de estos cambia, macOS trata la app como nueva y puede eliminar u ocultar prompts.

## Requisitos para permisos estables

- Misma ruta: ejecuta la app desde una ubicación fija (para OpenClaw, `dist/OpenClaw.app`).
- Mismo identificador de bundle: cambiar el ID del bundle crea una nueva identidad de permisos.
- App firmada: las compilaciones sin firmar o firmadas ad-hoc no persisten permisos.
- Firma consistente: usa un certificado real de Apple Development o Developer ID para que la firma permanezca estable entre recompilaciones.

Las firmas ad-hoc generan una nueva identidad en cada compilación. macOS olvidará otorgamientos anteriores, y los prompts pueden desaparecer por completo hasta que se limpien las entradas obsoletas.

## Checklist de recuperación cuando los prompts desaparecen

1. Cierra la app.
2. Elimina la entrada de la app en System Settings → Privacy & Security.
3. Reinicia la app desde la misma ruta y vuelve a otorgar permisos.
4. Si el prompt aún no aparece, reinicia las entradas TCC con `tccutil` e intenta de nuevo.
5. Algunos permisos solo reaparecen después de un reinicio completo de macOS.

Ejemplo de reinicios (reemplaza el ID del bundle según sea necesario):

```bash
sudo tccutil reset Accessibility bot.molt.mac
sudo tccutil reset ScreenCapture bot.molt.mac
sudo tccutil reset AppleEvents
```

## Permisos de archivos y carpetas (Desktop/Documents/Downloads)

macOS también puede restringir Desktop, Documents y Downloads para procesos de terminal/fondo. Si las lecturas de archivos o listados de directorios se cuelgan, otorga acceso al mismo contexto de proceso que realiza las operaciones de archivos (por ejemplo Terminal/iTerm, app lanzada por LaunchAgent, o proceso SSH).

Solución alternativa: mueve archivos al espacio de trabajo de OpenClaw (`~/.openclaw/workspace`) si deseas evitar otorgamientos por carpeta.

Si estás probando permisos, siempre firma con un certificado real. Las compilaciones ad-hoc solo son aceptables para ejecuciones locales rápidas donde los permisos no importan.
