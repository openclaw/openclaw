---
summary: "persistencia de permisos de macOS (TCC) y requisitos de firma"
read_when:
  - Depuración de avisos de permisos de macOS faltantes o bloqueados
  - Empaquetado o firma de la app de macOS
  - Cambio de IDs de paquete o rutas de instalación de la app
title: "Permisos de macOS"
---

# permisos de macOS (TCC)

Las concesiones de permisos de macOS son frágiles. TCC asocia una concesión de permisos con la
firma de código de la app, el identificador del paquete y la ruta en disco. Si alguno de estos cambia,
macOS trata la app como nueva y puede eliminar u ocultar los avisos.

## Requisitos para permisos estables

- Misma ruta: ejecute la app desde una ubicación fija (para OpenClaw, `dist/OpenClaw.app`).
- Mismo identificador de paquete: cambiar el ID del paquete crea una nueva identidad de permisos.
- App firmada: las compilaciones sin firmar o firmadas ad-hoc no conservan los permisos.
- Firma consistente: use un certificado real de Apple Development o Developer ID
  para que la firma se mantenga estable entre recompilaciones.

Las firmas ad-hoc generan una identidad nueva en cada compilación. macOS olvidará concesiones
anteriores, y los avisos pueden desaparecer por completo hasta que se borren las entradas obsoletas.

## Lista de verificación de recuperación cuando los avisos desaparecen

1. Cierre la app.
2. Elimine la entrada de la app en Configuración del sistema -> Privacidad y seguridad.
3. Vuelva a iniciar la app desde la misma ruta y vuelva a conceder los permisos.
4. Si el aviso aún no aparece, restablezca las entradas de TCC con `tccutil` e inténtelo de nuevo.
5. Algunos permisos solo reaparecen después de un reinicio completo de macOS.

Ejemplos de restablecimiento (reemplace el ID del paquete según sea necesario):

```bash
sudo tccutil reset Accessibility bot.molt.mac
sudo tccutil reset ScreenCapture bot.molt.mac
sudo tccutil reset AppleEvents
```

## Permisos de archivos y carpetas (Escritorio/Documentos/Descargas)

macOS también puede restringir Escritorio, Documentos y Descargas para procesos de terminal/en segundo plano. Si las lecturas de archivos o los listados de directorios se quedan colgados, conceda acceso al mismo contexto de proceso que realiza las operaciones de archivos (por ejemplo, Terminal/iTerm, una app iniciada por LaunchAgent o un proceso SSH).

Solución alternativa: mueva los archivos al espacio de trabajo de OpenClaw (`~/.openclaw/workspace`) si desea evitar concesiones por carpeta.

Si está probando permisos, firme siempre con un certificado real. Las compilaciones ad-hoc
solo son aceptables para ejecuciones locales rápidas en las que los permisos no importan.
