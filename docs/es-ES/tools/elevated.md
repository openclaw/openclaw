---
title: "Privilegios Elevados"
description: "Ejecuta comandos con permisos elevados de forma segura"
---

## Descripción General

La herramienta `elevated` permite a los agentes ejecutar comandos que requieren permisos elevados (sudo/admin) con aprobaciones de seguridad adecuadas.

## Uso Básico

```typescript
// Ejecutar un comando con privilegios elevados
await elevated.exec({
  command: "apt-get update",
  reason: "Actualizar la lista de paquetes del sistema",
});
```

## Parámetros

| Parámetro | Tipo   | Requerido | Descripción                                               |
| --------- | ------ | --------- | --------------------------------------------------------- |
| `command` | string | Sí        | El comando a ejecutar con privilegios elevados            |
| `reason`  | string | Sí        | Explicación del por qué se necesitan privilegios elevados |
| `timeout` | number | No        | Tiempo de espera en milisegundos (por defecto: 30000)     |

## Flujo de Seguridad

1. **Solicitud**: El agente solicita privilegios elevados con un motivo
2. **Aprobación**: Se solicita al usuario aprobar la solicitud
3. **Ejecución**: Si se aprueba, el comando se ejecuta
4. **Auditoría**: Todas las ejecuciones elevadas se registran

## Ejemplos

### Instalar Paquetes del Sistema

```typescript
await elevated.exec({
  command: "apt-get install -y docker.io",
  reason: "Instalar Docker para herramientas de contenedorización",
});
```

### Modificar Archivos del Sistema

```typescript
await elevated.exec({
  command: 'echo "127.0.0.1 test.local" >> /etc/hosts',
  reason: "Agregar entrada al archivo hosts para pruebas locales",
});
```

### Reiniciar Servicios

```typescript
await elevated.exec({
  command: "systemctl restart nginx",
  reason: "Aplicar cambios de configuración de Nginx",
});
```

## Mejores Prácticas de Seguridad

1. **Siempre proporciona un motivo claro**: Ayuda a los usuarios a entender por qué se necesitan permisos
2. **Minimiza el uso**: Solo solicita privilegios elevados cuando sea absolutamente necesario
3. **Sé específico**: Ejecuta comandos específicos en lugar de abrir un shell raíz
4. **Audita regularmente**: Revisa los logs de comandos elevados en `~/.openclaw/logs/elevated.log`

## Configuración

Configura el comportamiento de comandos elevados:

```bash
# Habilitar aprobaciones automáticas (no recomendado)
openclaw config set elevated.autoApprove false

# Establecer tiempo de espera predeterminado
openclaw config set elevated.defaultTimeout 60000

# Habilitar registro detallado
openclaw config set elevated.verboseLogging true
```

## Solución de Problemas

### Fallo de Autenticación

Si los comandos elevados fallan con errores de autenticación:

```bash
# Verifica configuración de sudo
sudo -v

# Asegúrate de que tu usuario esté en el grupo sudo/wheel
groups $USER
```

### Tiempo de Espera de Comandos

Para comandos de larga duración:

```typescript
await elevated.exec({
  command: "apt-get upgrade -y",
  reason: "Actualizar todos los paquetes del sistema",
  timeout: 300000, // 5 minutos
});
```
