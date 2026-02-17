---
title: "Inicio de Sesión del Navegador"
description: "Gestiona sesiones de inicio de sesión y cookies del navegador"
---

## Descripción General

La herramienta `browser-login` permite a los agentes gestionar autenticación y sesiones del navegador. Esto habilita:

- **Sesiones persistentes**: Mantiene inicios de sesión entre ejecuciones de agentes
- **Autenticación automatizada**: Maneja flujos de inicio de sesión automáticamente
- **Gestión de cookies**: Guarda y restaura cookies del navegador
- **Automatización multi-sitio**: Gestiona múltiples cuentas de usuario en diferentes sitios

## Uso Básico

```typescript
// Guardar el estado de inicio de sesión actual
await browserLogin.save({
  name: 'github-session',
  url: 'https://github.com'
});

// Restaurar una sesión guardada
await browserLogin.restore({
  name: 'github-session'
});

// Listar sesiones guardadas
const sessions = await browserLogin.list();
```

## Parámetros

### Guardar Sesión

| Parámetro | Tipo | Requerido | Descripción |
|-----------|------|-----------|-------------|
| `name` | string | Sí | Identificador único para esta sesión |
| `url` | string | No | URL para asociar con esta sesión |

### Restaurar Sesión

| Parámetro | Tipo | Requerido | Descripción |
|-----------|------|-----------|-------------|
| `name` | string | Sí | Nombre de la sesión a restaurar |

## Ejemplos

### Iniciar Sesión y Guardar

```typescript
// Navega a la página de inicio de sesión
await browser.navigate('https://example.com/login');

// Realiza el inicio de sesión
await browser.type('#username', 'mi-usuario');
await browser.type('#password', 'mi-contraseña');
await browser.click('#login-button');

// Espera a que el inicio de sesión se complete
await browser.waitFor({ text: 'Panel de Control' });

// Guarda el estado de inicio de sesión
await browserLogin.save({
  name: 'example-session',
  url: 'https://example.com'
});
```

### Reutilizar Sesión Guardada

```typescript
// Restaurar sesión previamente guardada
await browserLogin.restore({
  name: 'example-session'
});

// Ahora estás iniciado sesión y puedes continuar
await browser.navigate('https://example.com/dashboard');
```

## Notas de Seguridad

- Las sesiones se almacenan de forma segura en `~/.openclaw/browser-sessions/`
- Las cookies y los tokens de sesión se encriptan en reposo
- Nunca compartas archivos de sesión, ya que contienen credenciales de autenticación
- Considera rotar sesiones periódicamente por seguridad
