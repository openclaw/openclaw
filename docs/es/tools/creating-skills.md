---
title: "Creación de Skills"
---

# Creación de Skills personalizados 🛠

OpenClaw está diseñado para ser fácilmente extensible. Los "Skills" son la forma principal de agregar nuevas capacidades a su asistente.

## ¿Qué es un Skill?

Un Skill es un directorio que contiene un archivo `SKILL.md` (que proporciona instrucciones y definiciones de herramientas al LLM) y, opcionalmente, algunos scripts o recursos.

## Paso a paso: su primer Skill

### 1. Crear el directorio

Los Skills viven en su espacio de trabajo, por lo general `~/.openclaw/workspace/skills/`. Cree una nueva carpeta para su Skill:

```bash
mkdir -p ~/.openclaw/workspace/skills/hello-world
```

### 2. Definir el `SKILL.md`

Cree un archivo `SKILL.md` en ese directorio. Este archivo usa frontmatter YAML para los metadatos y Markdown para las instrucciones.

```markdown
---
name: hello_world
description: A simple skill that says hello.
---

# Hello World Skill

When the user asks for a greeting, use the `echo` tool to say "Hello from your custom skill!".
```

### 3. Agregar herramientas (opcional)

Puede definir herramientas personalizadas en el frontmatter o indicar al agente que use herramientas del sistema existentes (como `bash` o `browser`).

### 4. Actualizar OpenClaw

Pida a su agente que "actualice los Skills" o reinicie el Gateway. OpenClaw descubrirá el nuevo directorio e indexará el `SKILL.md`.

## Mejores prácticas

- **Sea conciso**: Indique al modelo _qué_ hacer, no cómo ser una IA.
- **Seguridad ante todo**: Si su Skill usa `bash`, asegúrese de que los prompts no permitan la inyección arbitraria de comandos desde entradas de usuario no confiables.
- **Pruebe localmente**: Use `openclaw agent --message "use my new skill"` para probar.

## Skills compartidos

También puede explorar y contribuir Skills en [ClawHub](https://clawhub.com).
