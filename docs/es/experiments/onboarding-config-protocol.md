---
summary: "Notas del protocolo RPC para el asistente de onboarding y el esquema de configuración"
read_when: "Al cambiar los pasos del asistente de onboarding o los endpoints del esquema de configuración"
title: "Protocolo de Onboarding y Configuración"
---

# Protocolo de Onboarding + Configuración

Propósito: superficies compartidas de onboarding y configuración en la CLI, la app de macOS y la UI Web.

## Componentes

- Motor del asistente (sesión compartida + prompts + estado de onboarding).
- El onboarding de la CLI usa el mismo flujo del asistente que los clientes de UI.
- El RPC del Gateway expone endpoints del asistente y del esquema de configuración.
- El onboarding de macOS usa el modelo de pasos del asistente.
- La UI Web renderiza formularios de configuración a partir de JSON Schema + pistas de UI.

## RPC del Gateway

- `wizard.start` params: `{ mode?: "local"|"remote", workspace?: string }`
- `wizard.next` params: `{ sessionId, answer?: { stepId, value? } }`
- `wizard.cancel` params: `{ sessionId }`
- `wizard.status` params: `{ sessionId }`
- `config.schema` params: `{}`

Respuestas (forma)

- Asistente: `{ sessionId, done, step?, status?, error? }`
- Esquema de configuración: `{ schema, uiHints, version, generatedAt }`

## Pistas de UI

- `uiHints` con clave por ruta; metadatos opcionales (label/help/group/order/advanced/sensitive/placeholder).
- Los campos sensibles se renderizan como entradas de contraseña; no hay capa de ofuscación.
- Los nodos de esquema no compatibles recurren al editor JSON sin procesar.

## Notas

- Este documento es el único lugar para dar seguimiento a refactorizaciones del protocolo de onboarding/configuración.
