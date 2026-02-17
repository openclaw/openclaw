---
summary: "Delegar la autenticación del gateway a un proxy inverso confiable (Pomerium, Caddy, nginx + OAuth)"
read_when:
  - Ejecutar OpenClaw detrás de un proxy con reconocimiento de identidad
  - Configurar Pomerium, Caddy o nginx con OAuth frente a OpenClaw
  - Corregir errores WebSocket 1008 no autorizados con configuraciones de proxy inverso
---

# Autenticación de proxy confiable

> ⚠️ **Característica sensible a la seguridad.** Este modo delega la autenticación completamente a tu proxy inverso. Una configuración incorrecta puede exponer tu Gateway a acceso no autorizado. Lee esta página cuidadosamente antes de habilitar.

## Cuándo usar

Usa el modo de autenticación `trusted-proxy` cuando:

- Ejecutes OpenClaw detrás de un **proxy con reconocimiento de identidad** (Pomerium, Caddy + OAuth, nginx + oauth2-proxy, Traefik + forward auth)
- Tu proxy maneje toda la autenticación y pase la identidad del usuario mediante encabezados
- Estés en un entorno Kubernetes o de contenedores donde el proxy es el único camino hacia el Gateway
- Estés enfrentando errores WebSocket `1008 unauthorized` porque los navegadores no pueden pasar tokens en payloads WS

## Cuándo NO usar

- Si tu proxy no autentica usuarios (solo es un terminador TLS o balanceador de carga)
- Si hay algún camino hacia el Gateway que evite el proxy (agujeros de firewall, acceso de red interna)
- Si no estás seguro de si tu proxy elimina/sobrescribe correctamente los encabezados reenviados
- Si solo necesitas acceso personal de un solo usuario (considera Tailscale Serve + loopback para una configuración más simple)

## Cómo funciona

1. Tu proxy inverso autentica usuarios (OAuth, OIDC, SAML, etc.)
2. El proxy agrega un encabezado con la identidad del usuario autenticado (ej., `x-forwarded-user: nick@example.com`)
3. OpenClaw verifica que la solicitud provino de una **IP de proxy confiable** (configurada en `gateway.trustedProxies`)
4. OpenClaw extrae la identidad del usuario del encabezado configurado
5. Si todo está correcto, la solicitud es autorizada

## Configuración

```json5
{
  gateway: {
    // Debe vincularse a interfaz de red (no loopback)
    bind: "lan",

    // CRÍTICO: Solo agrega aquí la(s) IP(s) de tu proxy
    trustedProxies: ["10.0.0.1", "172.17.0.1"],

    auth: {
      mode: "trusted-proxy",
      trustedProxy: {
        // Encabezado que contiene la identidad del usuario autenticado (requerido)
        userHeader: "x-forwarded-user",

        // Opcional: encabezados que DEBEN estar presentes (verificación de proxy)
        requiredHeaders: ["x-forwarded-proto", "x-forwarded-host"],

        // Opcional: restringir a usuarios específicos (vacío = permitir todos)
        allowUsers: ["nick@example.com", "admin@company.org"],
      },
    },
  },
}
```

### Referencia de configuración

| Campo                                       | Requerido | Descripción                                                                        |
| ------------------------------------------- | --------- | ---------------------------------------------------------------------------------- |
| `gateway.trustedProxies`                    | Sí        | Array de direcciones IP de proxy confiables. Solicitudes de otras IPs son rechazadas. |
| `gateway.auth.mode`                         | Sí        | Debe ser `"trusted-proxy"`                                                         |
| `gateway.auth.trustedProxy.userHeader`      | Sí        | Nombre del encabezado que contiene la identidad del usuario autenticado            |
| `gateway.auth.trustedProxy.requiredHeaders` | No        | Encabezados adicionales que deben estar presentes para que la solicitud sea confiable |
| `gateway.auth.trustedProxy.allowUsers`      | No        | Lista de identidades de usuario permitidas. Vacío significa permitir todos los usuarios autenticados. |

## Ejemplos de configuración de proxy

### Pomerium

Pomerium pasa la identidad en `x-pomerium-claim-email` (u otros encabezados de reclamación) y un JWT en `x-pomerium-jwt-assertion`.

```json5
{
  gateway: {
    bind: "lan",
    trustedProxies: ["10.0.0.1"], // IP de Pomerium
    auth: {
      mode: "trusted-proxy",
      trustedProxy: {
        userHeader: "x-pomerium-claim-email",
        requiredHeaders: ["x-pomerium-jwt-assertion"],
      },
    },
  },
}
```

Fragmento de configuración de Pomerium:

```yaml
routes:
  - from: https://openclaw.example.com
    to: http://openclaw-gateway:18789
    policy:
      - allow:
          or:
            - email:
                is: nick@example.com
    pass_identity_headers: true
```

### Caddy con OAuth

Caddy con el plugin `caddy-security` puede autenticar usuarios y pasar encabezados de identidad.

```json5
{
  gateway: {
    bind: "lan",
    trustedProxies: ["127.0.0.1"], // IP de Caddy (si está en el mismo host)
    auth: {
      mode: "trusted-proxy",
      trustedProxy: {
        userHeader: "x-forwarded-user",
      },
    },
  },
}
```

Fragmento de Caddyfile:

```
openclaw.example.com {
    authenticate with oauth2_provider
    authorize with policy1

    reverse_proxy openclaw:18789 {
        header_up X-Forwarded-User {http.auth.user.email}
    }
}
```

### nginx + oauth2-proxy

oauth2-proxy autentica usuarios y pasa la identidad en `x-auth-request-email`.

```json5
{
  gateway: {
    bind: "lan",
    trustedProxies: ["10.0.0.1"], // IP de nginx/oauth2-proxy
    auth: {
      mode: "trusted-proxy",
      trustedProxy: {
        userHeader: "x-auth-request-email",
      },
    },
  },
}
```

Fragmento de configuración de nginx:

```nginx
location / {
    auth_request /oauth2/auth;
    auth_request_set $user $upstream_http_x_auth_request_email;

    proxy_pass http://openclaw:18789;
    proxy_set_header X-Auth-Request-Email $user;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
}
```

### Traefik con Forward Auth

```json5
{
  gateway: {
    bind: "lan",
    trustedProxies: ["172.17.0.1"], // IP del contenedor Traefik
    auth: {
      mode: "trusted-proxy",
      trustedProxy: {
        userHeader: "x-forwarded-user",
      },
    },
  },
}
```

## Lista de verificación de seguridad

Antes de habilitar autenticación de proxy confiable, verifica:

- [ ] **El proxy es el único camino**: El puerto del Gateway está protegido por firewall de todo excepto tu proxy
- [ ] **trustedProxies es mínimo**: Solo las IPs reales de tu proxy, no subredes enteras
- [ ] **El proxy elimina encabezados**: Tu proxy sobrescribe (no agrega) encabezados `x-forwarded-*` de clientes
- [ ] **Terminación TLS**: Tu proxy maneja TLS; los usuarios se conectan mediante HTTPS
- [ ] **allowUsers está configurado** (recomendado): Restringir a usuarios conocidos en lugar de permitir cualquier usuario autenticado

## Auditoría de seguridad

`openclaw security audit` marcará la autenticación de proxy confiable con un hallazgo de severidad **crítica**. Esto es intencional — es un recordatorio de que estás delegando seguridad a tu configuración de proxy.

La auditoría verifica:

- Configuración de `trustedProxies` faltante
- Configuración de `userHeader` faltante
- `allowUsers` vacío (permite cualquier usuario autenticado)

## Solución de problemas

### "trusted_proxy_untrusted_source"

La solicitud no provino de una IP en `gateway.trustedProxies`. Verifica:

- ¿Es correcta la IP del proxy? (Las IPs de contenedores Docker pueden cambiar)
- ¿Hay un balanceador de carga frente a tu proxy?
- Usa `docker inspect` o `kubectl get pods -o wide` para encontrar las IPs reales

### "trusted_proxy_user_missing"

El encabezado de usuario estaba vacío o faltante. Verifica:

- ¿Está configurado tu proxy para pasar encabezados de identidad?
- ¿Es correcto el nombre del encabezado? (insensible a mayúsculas, pero la ortografía importa)
- ¿Está el usuario realmente autenticado en el proxy?

### "trusted_proxy_missing_header_*"

Un encabezado requerido no estaba presente. Verifica:

- Tu configuración de proxy para esos encabezados específicos
- Si los encabezados están siendo eliminados en algún lugar de la cadena

### "trusted_proxy_user_not_allowed"

El usuario está autenticado pero no está en `allowUsers`. Agrégalo o elimina la lista de permitidos.

### WebSocket sigue fallando

Asegúrate de que tu proxy:

- Admite actualizaciones WebSocket (`Upgrade: websocket`, `Connection: upgrade`)
- Pasa los encabezados de identidad en solicitudes de actualización WebSocket (no solo HTTP)
- No tiene una ruta de autenticación separada para conexiones WebSocket

## Migración desde autenticación con token

Si estás migrando de autenticación con token a proxy confiable:

1. Configura tu proxy para autenticar usuarios y pasar encabezados
2. Prueba la configuración del proxy independientemente (curl con encabezados)
3. Actualiza la configuración de OpenClaw con autenticación de proxy confiable
4. Reinicia el Gateway
5. Prueba conexiones WebSocket desde la UI de control
6. Ejecuta `openclaw security audit` y revisa los hallazgos

## Relacionado

- [Seguridad](/es-ES/gateway/security) — guía completa de seguridad
- [Configuración](/es-ES/gateway/configuration) — referencia de configuración
- [Acceso remoto](/es-ES/gateway/remote) — otros patrones de acceso remoto
- [Tailscale](/es-ES/gateway/tailscale) — alternativa más simple para acceso solo en tailnet
