---
title: Pipeline de CI
description: Cómo funciona el pipeline de CI de OpenClaw
---

# Pipeline de CI

El CI se ejecuta en cada push a `main` y en cada pull request. Utiliza alcance inteligente para omitir trabajos costosos cuando solo cambian documentación o código nativo.

## Resumen de trabajos

| Trabajo           | Propósito                                       | Cuándo se ejecuta             |
| ----------------- | ----------------------------------------------- | ----------------------------- |
| `docs-scope`      | Detectar cambios solo en documentación         | Siempre                       |
| `changed-scope`   | Detectar qué áreas cambiaron (node/macos/android) | PRs que no son solo docs      |
| `check`           | Tipos TypeScript, lint, formato                 | Cambios que no son solo docs  |
| `check-docs`      | Lint de Markdown + verificación de enlaces rotos | Documentación modificada      |
| `code-analysis`   | Verificación de umbral de LOC (1000 líneas)     | Solo PRs                      |
| `secrets`         | Detectar secretos filtrados                     | Siempre                       |
| `build-artifacts` | Construir dist una vez, compartir con otros trabajos | No docs, cambios en node      |
| `release-check`   | Validar contenidos de npm pack                  | Después de build              |
| `checks`          | Pruebas Node/Bun + verificación de protocolo    | No docs, cambios en node      |
| `checks-windows`  | Pruebas específicas de Windows                  | No docs, cambios en node      |
| `macos`           | Swift lint/build/test + pruebas TS              | PRs con cambios en macos      |
| `android`         | Build y pruebas de Gradle                       | No docs, cambios en android   |

## Orden de Fail-Fast

Los trabajos están ordenados para que las verificaciones económicas fallen antes de que se ejecuten las costosas:

1. `docs-scope` + `code-analysis` + `check` (paralelo, ~1-2 min)
2. `build-artifacts` (bloqueado por los anteriores)
3. `checks`, `checks-windows`, `macos`, `android` (bloqueados por build)

## Runners

| Runner                          | Trabajos                      |
| ------------------------------- | ----------------------------- |
| `blacksmith-4vcpu-ubuntu-2404`  | La mayoría de trabajos Linux  |
| `blacksmith-4vcpu-windows-2025` | `checks-windows`              |
| `macos-latest`                  | `macos`, `ios`                |
| `ubuntu-latest`                 | Detección de alcance (ligero) |

## Equivalentes locales

```bash
pnpm check          # tipos + lint + formato
pnpm test           # pruebas vitest
pnpm check:docs     # formato docs + lint + enlaces rotos
pnpm release:check  # validar npm pack
```
