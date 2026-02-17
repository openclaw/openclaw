---
summary: "Exploración: configuración de modelos, perfiles de autenticación y comportamiento de fallback"
read_when:
  - Explorando ideas futuras de selección de modelo + perfil de autenticación
title: "Exploración de Configuración de Modelos"
---

# Configuración de Modelos (Exploración)

Este documento captura **ideas** para la configuración futura de modelos. No es una especificación de envío. Para el comportamiento actual, consulta:

- [Modelos](/es-ES/concepts/models)
- [Failover de modelos](/es-ES/concepts/model-failover)
- [OAuth + perfiles](/es-ES/concepts/oauth)

## Motivación

Los operadores quieren:

- Múltiples perfiles de autenticación por proveedor (personal vs trabajo).
- Selección simple de `/model` con fallbacks predecibles.
- Separación clara entre modelos de texto y modelos capaces de imágenes.

## Dirección posible (alto nivel)

- Mantener la selección de modelos simple: `provider/model` con alias opcionales.
- Permitir que los proveedores tengan múltiples perfiles de autenticación, con un orden explícito.
- Usar una lista de fallback global para que todas las sesiones fallen de manera consistente.
- Solo anular el enrutamiento de imágenes cuando esté configurado explícitamente.

## Preguntas abiertas

- ¿Debería la rotación de perfiles ser por proveedor o por modelo?
- ¿Cómo debería la UI mostrar la selección de perfil para una sesión?
- ¿Cuál es la ruta de migración más segura desde las claves de configuración heredadas?
