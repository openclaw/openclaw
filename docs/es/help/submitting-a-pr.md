---
summary: "Cómo enviar un PR de alta señal"
title: "Envío de un PR"
---

Los buenos PR son fáciles de revisar: los revisores deben comprender rápidamente la intención, verificar el comportamiento y integrar los cambios de forma segura. Esta guía cubre envíos concisos y de alta señal para revisión humana y por LLM.

## Qué hace que un PR sea bueno

- [ ] Explique el problema, por qué importa y el cambio.
- [ ] Mantenga los cambios enfocados. Evite refactorizaciones amplias.
- [ ] Resuma los cambios visibles para el usuario/configuración/valores predeterminados.
- [ ] Enumere la cobertura de pruebas, omisiones y razones.
- [ ] Agregue evidencia: registros, capturas de pantalla o grabaciones (UI/UX).
- [ ] Palabra clave: ponga “lobster-biscuit” en la descripción del PR si leyó esta guía.
- [ ] Ejecute/arregle los comandos `pnpm` relevantes antes de crear el PR.
- [ ] Busque en el código y en GitHub funcionalidad/problemas/arreglos relacionados.
- [ ] Base las afirmaciones en evidencia u observación.
- [ ] Buen título: verbo + alcance + resultado (p. ej., `Docs: add PR and issue templates`).

Sea conciso; revisión concisa > gramática. Omita cualquier sección no aplicable.

### Comandos de validación base (ejecute/arregle fallas para su cambio)

- `pnpm lint`
- `pnpm check`
- `pnpm build`
- `pnpm test`
- Cambios de protocolo: `pnpm protocol:check`

## Divulgación progresiva

- Arriba: resumen/intención
- Luego: cambios/riesgos
- Luego: pruebas/verificación
- Al final: implementación/evidencia

## Tipos comunes de PR: detalles

- [ ] Arreglo: agregue reproducción, causa raíz, verificación.
- [ ] Funcionalidad: agregue casos de uso, comportamiento/demos/capturas (UI).
- [ ] Refactorización: indique “sin cambio de comportamiento”, enumere qué se movió/simplificó.
- [ ] Tarea: indique por qué (p. ej., tiempo de compilación, CI, dependencias).
- [ ] Documentación: contexto antes/después, enlace a la página actualizada, ejecute `pnpm format`.
- [ ] Pruebas: qué brecha se cubre; cómo previene regresiones.
- [ ] Rendimiento: agregue métricas antes/después y cómo se midieron.
- [ ] UX/UI: capturas de pantalla/video, note el impacto en accesibilidad.
- [ ] Infraestructura/Build: entornos/validación.
- [ ] Seguridad: resuma el riesgo, reproducción, verificación; sin datos sensibles. Afirmaciones fundamentadas únicamente.

## Lista de verificación

- [ ] Problema/intención claros
- [ ] Alcance enfocado
- [ ] Lista de cambios de comportamiento
- [ ] Lista y resultado de las pruebas
- [ ] Pasos de prueba manual (cuando aplique)
- [ ] Sin secretos/datos privados
- [ ] Basado en evidencia

## Plantilla general de PR

```md
#### Summary

#### Behavior Changes

#### Codebase and GitHub Search

#### Tests

#### Manual Testing (omit if N/A)

### Prerequisites

-

### Steps

1.
2.

#### Evidence (omit if N/A)

**Sign-Off**

- Models used:
- Submitter effort (self-reported):
- Agent notes (optional, cite evidence):
```

## Plantillas por tipo de PR (reemplace con su tipo)

### Solución

```md
#### Summary

#### Repro Steps

#### Root Cause

#### Behavior Changes

#### Tests

#### Manual Testing (omit if N/A)

### Prerequisites

-

### Steps

1.
2.

#### Evidence (omit if N/A)

**Sign-Off**

- Models used:
- Submitter effort:
- Agent notes:
```

### Funcionalidad

```md
#### Summary

#### Use Cases

#### Behavior Changes

#### Existing Functionality Check

- [ ] I searched the codebase for existing functionality.
      Searches performed (1-3 bullets):
  -
  -

#### Tests

#### Manual Testing (omit if N/A)

### Prerequisites

-

### Steps

1.
2.

#### Evidence (omit if N/A)

**Sign-Off**

- Models used:
- Submitter effort:
- Agent notes:
```

### Refactorización

```md
#### Summary

#### Scope

#### No Behavior Change Statement

#### Tests

#### Manual Testing (omit if N/A)

### Prerequisites

-

### Steps

1.
2.

#### Evidence (omit if N/A)

**Sign-Off**

- Models used:
- Submitter effort:
- Agent notes:
```

### Tarea/Mantenimiento

```md
#### Summary

#### Why This Matters

#### Tests

#### Manual Testing (omit if N/A)

### Prerequisites

-

### Steps

1.
2.

#### Evidence (omit if N/A)

**Sign-Off**

- Models used:
- Submitter effort:
- Agent notes:
```

### Documentación

```md
#### Summary

#### Pages Updated

#### Before/After

#### Formatting

pnpm format

#### Evidence (omit if N/A)

**Sign-Off**

- Models used:
- Submitter effort:
- Agent notes:
```

### Pruebas

```md
#### Summary

#### Gap Covered

#### Tests

#### Manual Testing (omit if N/A)

### Prerequisites

-

### Steps

1.
2.

#### Evidence (omit if N/A)

**Sign-Off**

- Models used:
- Submitter effort:
- Agent notes:
```

### Perf

```md
#### Summary

#### Baseline

#### After

#### Measurement Method

#### Tests

#### Manual Testing (omit if N/A)

### Prerequisites

-

### Steps

1.
2.

#### Evidence (omit if N/A)

**Sign-Off**

- Models used:
- Submitter effort:
- Agent notes:
```

### UX/UI

```md
#### Summary

#### Screenshots or Video

#### Accessibility Impact

#### Tests

#### Manual Testing

### Prerequisites

-

### Steps

1.
2. **Sign-Off**

- Models used:
- Submitter effort:
- Agent notes:
```

### Infraestructura/Build

```md
#### Summary

#### Environments Affected

#### Validation Steps

#### Manual Testing (omit if N/A)

### Prerequisites

-

### Steps

1.
2.

#### Evidence (omit if N/A)

**Sign-Off**

- Models used:
- Submitter effort:
- Agent notes:
```

### Seguridad

```md
#### Summary

#### Risk Summary

#### Repro Steps

#### Mitigation or Fix

#### Verification

#### Tests

#### Manual Testing (omit if N/A)

### Prerequisites

-

### Steps

1.
2.

#### Evidence (omit if N/A)

**Sign-Off**

- Models used:
- Submitter effort:
- Agent notes:
```
