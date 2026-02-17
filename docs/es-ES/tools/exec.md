---
title: "Exec"
description: "Ejecuta comandos del sistema con control de seguridad"
---

## Descripción General

La herramienta `exec` permite a los agentes ejecutar comandos del sistema con verificaciones de seguridad y controles de aprobación adecuados.

## Uso Básico

```typescript
// Ejecutar un comando simple
const result = await exec({
  command: "ls -la",
  cwd: "/home/usuario/proyecto",
});

console.log(result.stdout);
```

## Parámetros

| Parámetro | Tipo   | Requerido | Descripción                                            |
| --------- | ------ | --------- | ------------------------------------------------------ |
| `command` | string | Sí        | El comando a ejecutar                                  |
| `cwd`     | string | No        | Directorio de trabajo (por defecto: directorio actual) |
| `env`     | object | No        | Variables de entorno adicionales                       |
| `timeout` | number | No        | Tiempo de espera en milisegundos (por defecto: 30000)  |
| `shell`   | string | No        | Shell a usar (por defecto: /bin/sh)                    |

## Resultado de la Ejecución

```typescript
interface ExecResult {
  stdout: string; // Salida estándar
  stderr: string; // Salida de error
  exitCode: number; // Código de salida del comando
  duration: number; // Duración de ejecución en ms
}
```

## Ejemplos

### Comandos Básicos

```typescript
// Listar archivos
const files = await exec({ command: "ls -la" });

// Verificar versión de Node
const nodeVersion = await exec({ command: "node --version" });

// Búsqueda con Grep
const matches = await exec({
  command: 'grep -r "TODO" ./src',
  cwd: "/home/usuario/proyecto",
});
```

### Trabajar con Directorios

```typescript
// Cambiar directorio y ejecutar comando
const result = await exec({
  command: "npm test",
  cwd: "/home/usuario/mi-proyecto",
});
```

### Variables de Entorno

```typescript
// Ejecutar con variables de entorno personalizadas
const result = await exec({
  command: "node script.js",
  env: {
    NODE_ENV: "production",
    API_KEY: "xxx",
  },
});
```

### Tiempo de Espera de Comandos

```typescript
// Establecer tiempo de espera personalizado para comandos de larga duración
const result = await exec({
  command: "npm install",
  timeout: 300000, // 5 minutos
});
```

### Ejecutar Scripts

```typescript
// Ejecutar un script de shell
const result = await exec({
  command: "./build.sh",
  cwd: "/home/usuario/proyecto",
  shell: "/bin/bash",
});
```

## Controles de Seguridad

### Lista Blanca de Comandos

Los comandos se comparan con una lista blanca configurable:

```bash
# Ver comandos permitidos
openclaw config get exec.allowedCommands

# Agregar comando a la lista blanca
openclaw config set exec.allowedCommands.git true
```

### Comandos Bloqueados

Ciertos comandos peligrosos están bloqueados por defecto:

- `rm -rf /`
- `mkfs`
- `dd if=/dev/zero`
- `:(){ :|:& };:` (fork bomb)

### Aprobaciones Requeridas

Algunos comandos requieren aprobación del usuario:

```typescript
// Este comando solicitará aprobación del usuario
const result = await exec({
  command: "sudo apt-get install postgresql",
  requireApproval: true,
});
```

## Manejo de Errores

```typescript
try {
  const result = await exec({ command: "comando-no-existente" });
} catch (error) {
  if (error.code === "COMMAND_NOT_FOUND") {
    console.log("Comando no encontrado");
  } else if (error.code === "TIMEOUT") {
    console.log("Comando excedió el tiempo de espera");
  } else if (error.code === "PERMISSION_DENIED") {
    console.log("Permisos insuficientes");
  } else {
    console.log("Error de ejecución:", error.message);
  }
}
```

## Comandos Interactivos

Para comandos que requieren entrada interactiva, usa el modo streaming:

```typescript
const process = await exec({
  command: "npm init",
  interactive: true,
});

// Enviar entrada al proceso
process.stdin.write("mi-paquete\n");
process.stdin.write("1.0.0\n");

// Leer salida
process.stdout.on("data", (data) => {
  console.log(data.toString());
});
```

## Ejecución en Paralelo

Ejecuta múltiples comandos en paralelo:

```typescript
const results = await Promise.all([
  exec({ command: "npm test" }),
  exec({ command: "npm run lint" }),
  exec({ command: "npm run build" }),
]);

console.log("Todas las tareas completadas:", results);
```

## Comandos Encadenados

Ejecuta comandos secuencialmente:

```typescript
// Usando shell pipes
const result = await exec({
  command: 'cat file.txt | grep "error" | wc -l',
  shell: "/bin/bash",
});

// Usando ejecución secuencial
const build = await exec({ command: "npm run build" });
if (build.exitCode === 0) {
  const test = await exec({ command: "npm test" });
}
```

## Configuración

Configura el comportamiento de exec:

```bash
# Establecer tiempo de espera predeterminado
openclaw config set exec.defaultTimeout 30000

# Establecer shell predeterminado
openclaw config set exec.defaultShell /bin/bash

# Habilitar registro detallado
openclaw config set exec.verbose true

# Configurar comandos permitidos
openclaw config set exec.allowedCommands '["git", "npm", "node"]'
```

## Auditoría y Registro

Todas las ejecuciones de comandos se registran:

```bash
# Ver log de ejecuciones
cat ~/.openclaw/logs/exec.log

# Ver solo comandos fallidos
grep "ERROR" ~/.openclaw/logs/exec.log

# Ver estadísticas de ejecución
openclaw exec stats
```

## Mejores Prácticas

1. **Siempre especifica el directorio de trabajo**: Usa `cwd` para evitar sorpresas
2. **Establece tiempos de espera apropiados**: Previene que comandos se cuelguen indefinidamente
3. **Maneja errores correctamente**: Siempre captura y maneja excepciones
4. **Usa lista blanca cuando sea posible**: Restringe comandos por seguridad
5. **Registra salidas importantes**: Captura stdout/stderr para depuración
6. **Evita shell cuando sea posible**: Ejecuta binarios directamente para seguridad
7. **Sanitiza entradas**: Nunca pases entrada del usuario no sanitizada a comandos

## Comparación con Aprobaciones de Exec

| Característica       | `exec`                | `exec-approvals`               |
| -------------------- | --------------------- | ------------------------------ |
| Ejecución automática | Sí                    | Requiere aprobación            |
| Lista blanca         | Sí                    | Sí                             |
| Registro             | Sí                    | Sí + historial de aprobaciones |
| Mejor para           | Comandos de confianza | Comandos sensibles             |

Ver [Aprobaciones de Exec](/es-ES/tools/exec-approvals) para más información sobre el flujo de aprobación.

## Solución de Problemas

### El Comando No se Ejecuta

```bash
# Verifica que el comando exista
which nombre-comando

# Verifica permisos
ls -l /ruta/a/comando

# Verifica el PATH
echo $PATH
```

### Errores de Tiempo de Espera

```typescript
// Aumenta el tiempo de espera para comandos lentos
const result = await exec({
  command: "comando-lento",
  timeout: 600000, // 10 minutos
});
```

### Errores de Permisos

```typescript
// Usa herramienta elevated para comandos que requieren sudo
const result = await elevated.exec({
  command: "apt-get update",
  reason: "Actualizar paquetes del sistema",
});
```

## Ver También

- [Aprobaciones de Exec](/es-ES/tools/exec-approvals) - Flujo de aprobación de comandos
- [Elevated](/es-ES/tools/elevated) - Ejecutar comandos con sudo
- [Browser](/es-ES/tools/browser) - Automatización del navegador
