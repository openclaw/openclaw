---
title: Sondeo
description: Verificaciones programadas de recursos externos
---

El sondeo permite que tu Gateway OpenClaw verifique periódicamente recursos externos (APIs, archivos, servicios) y active acciones basadas en cambios o condiciones.

## Descripción general

Los trabajos de sondeo son scripts o comandos que:

- Se ejecutan en un horario regular
- Verifican el estado de un recurso externo
- Activan acciones cuando se detectan cambios
- Se integran con tu flujo de trabajo de automatización de OpenClaw

## Casos de uso

- Monitorear APIs para nuevos datos
- Verificar el estado de servicios externos
- Observar cambios en archivos o directorios
- Detectar actualizaciones de recursos
- Consultar bases de datos para nuevos registros

## Configuración básica

Añade trabajos de sondeo a `automation.cron` en la configuración de tu Gateway:

```yaml
automation:
  cron:
    - name: consultar-api
      # Verifica cada 5 minutos
      schedule: "*/5 * * * *"
      command: node /ruta/al/poll-api.js
```

## Ejemplo: Consultar una API

Crea un script que consulte una API y active acciones según la respuesta:

```javascript
// poll-api.js
const fetch = require("node-fetch");

async function checkAPI() {
  const response = await fetch("https://api.ejemplo.com/status");
  const data = await response.json();

  if (data.newItems > 0) {
    console.log(`Encontrados ${data.newItems} elementos nuevos`);
    // Activar una acción (enviar mensaje, webhook, etc.)
  }
}

checkAPI().catch(console.error);
```

## Ejemplo: Monitorear cambios de archivos

Verifica si un archivo ha cambiado desde la última ejecución:

```bash
#!/bin/bash
# poll-file.sh

FILE="/ruta/al/archivo.txt"
CHECKSUM_FILE="/tmp/archivo-checksum.txt"

# Calcular checksum actual
CURRENT=$(md5sum "$FILE" | cut -d' ' -f1)

# Leer checksum anterior
if [ -f "$CHECKSUM_FILE" ]; then
  PREVIOUS=$(cat "$CHECKSUM_FILE")
else
  PREVIOUS=""
fi

# Comparar
if [ "$CURRENT" != "$PREVIOUS" ]; then
  echo "Archivo cambiado. Activando acción..."
  # Tu lógica de acción aquí

  # Guardar nuevo checksum
  echo "$CURRENT" > "$CHECKSUM_FILE"
fi
```

## Mejores prácticas

### 1. Gestionar el estado entre ejecuciones

Guarda el estado (última ID verificada, checksums, timestamps) para rastrear cambios:

```javascript
const fs = require("fs");
const STATE_FILE = "/tmp/poll-state.json";

function loadState() {
  if (fs.existsSync(STATE_FILE)) {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  }
  return { lastId: 0 };
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state));
}

// Usar en tu lógica de sondeo
const state = loadState();
// ... verificar nuevos elementos desde state.lastId
state.lastId = newLastId;
saveState(state);
```

### 2. Manejar errores con gracia

Envuelve tu lógica de sondeo en manejo de errores para evitar fallos de tarea programada:

```javascript
async function poll() {
  try {
    // Tu lógica de sondeo
  } catch (error) {
    console.error("Error al sondear:", error);
    // Opcionalmente notificar sobre el error
  }
}
```

### 3. Limitar la frecuencia de sondeo

Evita sobrecargar servicios externos:

- Usa intervalos razonables (minutos, no segundos)
- Implementa retroceso exponencial en errores
- Respeta límites de tasa de APIs

## Próximos pasos

- Aprende sobre [Tareas programadas](/es-ES/automation/cron-jobs)
- Explora [Hooks](/es-ES/automation/hooks) para activación basada en eventos
- Revisa [Tareas programadas vs. Heartbeat](/es-ES/automation/cron-vs-heartbeat)
