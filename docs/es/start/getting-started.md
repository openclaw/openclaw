---
summary: "Instale OpenClaw y ejecute su primer chat en minutos."
read_when:
  - Configuración inicial desde cero
  - Quiere la ruta más rápida hacia un chat funcional
title: "Primeros pasos"
x-i18n:
  source_path: start/getting-started.md
  source_hash: 6eeb4d38a70f2ad9
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:34:37Z
---

# Primeros pasos

Objetivo: pasar de cero a un primer chat funcional con una configuración mínima.

<Info>
Chat más rápido: abra la Control UI (no se requiere configuración de canal). Ejecute `openclaw dashboard`
y chatee en el navegador, o abra `http://127.0.0.1:18789/` en el
<Tooltip headline="Gateway host" tip="La máquina que ejecuta el servicio Gateway de OpenClaw.">host del Gateway</Tooltip>.
Documentación: [Dashboard](/web/dashboard) y [Control UI](/web/control-ui).
</Info>

## Requisitos previos

- Node 22 o posterior

<Tip>
Verifique su versión de Node con `node --version` si no está seguro.
</Tip>

## Configuración rápida (CLI)

<Steps>
  <Step title="Instalar OpenClaw (recomendado)">
    <Tabs>
      <Tab title="macOS/Linux">
        ```bash
        curl -fsSL https://openclaw.ai/install.sh | bash
        ```
      </Tab>
      <Tab title="Windows (PowerShell)">
        ```powershell
        iwr -useb https://openclaw.ai/install.ps1 | iex
        ```
      </Tab>
    </Tabs>

    <Note>
    Otros métodos de instalación y requisitos: [Instalar](/install).
    </Note>

  </Step>
  <Step title="Ejecutar el asistente de incorporación">
    ```bash
    openclaw onboard --install-daemon
    ```

    El asistente configura la autenticación, los ajustes del Gateway y los canales opcionales.
    Consulte [Asistente de incorporación](/start/wizard) para más detalles.

  </Step>
  <Step title="Comprobar el Gateway">
    Si instaló el servicio, ya debería estar en ejecución:

    ```bash
    openclaw gateway status
    ```

  </Step>
  <Step title="Abrir la Control UI">
    ```bash
    openclaw dashboard
    ```
  </Step>
</Steps>

<Check>
Si la Control UI carga, su Gateway está listo para usarse.
</Check>

## Comprobaciones opcionales y extras

<AccordionGroup>
  <Accordion title="Ejecutar el Gateway en primer plano">
    Útil para pruebas rápidas o solución de problemas.

    ```bash
    openclaw gateway --port 18789
    ```

  </Accordion>
  <Accordion title="Enviar un mensaje de prueba">
    Requiere un canal configurado.

    ```bash
    openclaw message send --target +15555550123 --message "Hello from OpenClaw"
    ```

  </Accordion>
</AccordionGroup>

## Profundizar

<Columns>
  <Card title="Asistente de incorporación (detalles)" href="/start/wizard">
    Referencia completa del asistente de la CLI y opciones avanzadas.
  </Card>
  <Card title="Incorporación de la app de macOS" href="/start/onboarding">
    Flujo de primera ejecución para la app de macOS.
  </Card>
</Columns>

## Lo que tendrá

- Un Gateway en ejecución
- Autenticación configurada
- Acceso a la Control UI o un canal conectado

## Siguientes pasos

- Seguridad y aprobaciones de mensajes directos: [Emparejamiento](/channels/pairing)
- Conectar más canales: [Canales](/channels)
- Flujos de trabajo avanzados y desde el código fuente: [Configuración](/start/setup)
