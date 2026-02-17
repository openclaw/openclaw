---
summary: "Referencia CLI para `openclaw security` (auditar y corregir problemas comunes de seguridad)"
read_when:
  - Quieres ejecutar una auditoría rápida de seguridad en configuración/estado
  - Quieres aplicar sugerencias de "corrección" seguras (chmod, endurecer valores predeterminados)
title: "security"
---

# `openclaw security`

Herramientas de seguridad (auditoría + correcciones opcionales).

Relacionado:

- Guía de seguridad: [Seguridad](/es-ES/gateway/security)

## Auditoría

```bash
openclaw security audit
openclaw security audit --deep
openclaw security audit --fix
```

La auditoría advierte cuando múltiples remitentes de mensajes directos comparten la sesión principal y recomienda **modo de mensajes directos seguro**: `session.dmScope="per-channel-peer"` (o `per-account-channel-peer` para canales multi-cuenta) para bandejas de entrada compartidas.
También advierte cuando se usan modelos pequeños (`<=300B`) sin sandbox y con herramientas web/navegador habilitadas.
Para webhooks de entrada, advierte cuando `hooks.defaultSessionKey` no está configurado, cuando las anulaciones de `sessionKey` de solicitud están habilitadas, y cuando las anulaciones están habilitadas sin `hooks.allowedSessionKeyPrefixes`.
También advierte cuando la configuración Docker de sandbox está configurada mientras el modo sandbox está desactivado, cuando `gateway.nodes.denyCommands` usa entradas de patrón inefectivas/desconocidas, cuando `tools.profile="minimal"` global es anulado por perfiles de herramientas de agente, y cuando las herramientas de plugin de extensión instaladas pueden ser accesibles bajo política de herramientas permisiva.
