---
summary: "Presentar issues y reportes de errores de alta señal"
title: "Envío de un Issue"
---

## Envío de un Issue

Los issues claros y concisos aceleran el diagnóstico y las correcciones. Incluya lo siguiente para errores, regresiones o brechas de funcionalidades:

### Qué incluir

- [ ] Título: área y síntoma
- [ ] Pasos mínimos de reproducción
- [ ] Esperado vs. real
- [ ] Impacto y severidad
- [ ] Entorno: SO, runtime, versiones, configuración
- [ ] Evidencia: registros redactados, capturas de pantalla (sin PII)
- [ ] Alcance: nuevo, regresión o de larga data
- [ ] Palabra clave: lobster-biscuit en su issue
- [ ] Buscó en el codebase y en GitHub un issue existente
- [ ] Confirmó que no se haya corregido/atendido recientemente (especialmente seguridad)
- [ ] Afirmaciones respaldadas por evidencia o reproducción

Sea breve. La concisión > la gramática perfecta.

Validación (ejecutar/corregir antes del PR):

- `pnpm lint`
- `pnpm check`
- `pnpm build`
- `pnpm test`
- Si es código de protocolo: `pnpm protocol:check`

### Plantillas

#### Reporte de error

```md
- [ ] Minimal repro
- [ ] Expected vs actual
- [ ] Environment
- [ ] Affected channels, where not seen
- [ ] Logs/screenshots (redacted)
- [ ] Impact/severity
- [ ] Workarounds

### Summary

### Repro Steps

### Expected

### Actual

### Environment

### Logs/Evidence

### Impact

### Workarounds
```

#### Issue de seguridad

```md
### Summary

### Impact

### Versions

### Repro Steps (safe to share)

### Mitigation/workaround

### Evidence (redacted)
```

_Evite secretos/detalles de explotación en público. Para issues sensibles, minimice el detalle y solicite divulgación privada._

#### Reporte de regresión

```md
### Summary

### Last Known Good

### First Known Bad

### Repro Steps

### Expected

### Actual

### Environment

### Logs/Evidence

### Impact
```

#### Solicitud de funcionalidad

```md
### Summary

### Problem

### Proposed Solution

### Alternatives

### Impact

### Evidence/examples
```

#### Mejora

```md
### Summary

### Current vs Desired Behavior

### Rationale

### Alternatives

### Evidence/examples
```

#### Investigación

```md
### Summary

### Symptoms

### What Was Tried

### Environment

### Logs/Evidence

### Impact
```

### Envío de un PR de corrección

El issue previo al PR es opcional. Incluya los detalles en el PR si lo omite. Mantenga el PR enfocado, indique el número del issue, agregue pruebas o explique su ausencia, documente cambios de comportamiento/riesgos, incluya registros/capturas redactados como prueba y ejecute la validación adecuada antes de enviar.
