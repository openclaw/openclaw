---
summary: "Instale OpenClaw y ejecute su primer chat en minutos."
read_when:
  - Configuración inicial desde cero
  - Quiere la ruta más rápida hacia un chat funcional
title: "Comenzando"
---

# Comenzando

Objetivo: pasar de cero a un primer chat funcional con una configuración mínima.

<Info>
Chat más rápido: abra la Control UI (no se requiere configuración de canal). Ejecute `openclaw dashboard`
y chatee en el navegador, o abra `http://127.0.0.1:18789/` en el
<Tooltip headline="Gateway host" tip="The machine running the OpenClaw gateway service.">host del Gateway</Tooltip>.
Documentación: [Dashboard](/web/dashboard) y [Control UI](/web/control-ui).
</Info>

## Prereqs

- Node 22 o posterior

<Tip>
Verifique su versión de Node con `node --version` si no está seguro.
</Tip>

## Configuración rápida (CLI)

<Steps>
  <Step title="Install OpenClaw (recommended)">
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

    ```
    <Note>
    Otros métodos de instalación y requisitos: [Instalar](/install).
    </Note>
    ```

  </Step>
  <Step title="Run the onboarding wizard">
    ```bash
    openclaw onboard --install-daemon
    ```

    ```
    El asistente configura la autenticación, los ajustes del Gateway y los canales opcionales.
    Consulte [Asistente de incorporación](/start/wizard) para más detalles.
    ```

  </Step>
  <Step title="Check the Gateway">
    Si instaló el servicio, ya debería estar en ejecución:

    ````
    ```bash
    openclaw gateway status
    ```
    ````

  </Step>
  <Step title="Open the Control UI">
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
  <Accordion title="Run the Gateway in the foreground">
    Útil para pruebas rápidas o solución de problemas.

    ````
    ```bash
    openclaw gateway --port 18789
    ```
    ````

  </Accordion>
  <Accordion title="Send a test message">
    Requiere un canal configurado.

    ````
    ```bash
    openclaw message send --target +15555550123 --message "Hello from OpenClaw"
    ```
    ````

  </Accordion>
</AccordionGroup>

## Más profundo

<Columns>
  <Card title="Onboarding Wizard (details)" href="/start/wizard">
    Referencia completa del asistente de la CLI y opciones avanzadas.
  </Card>
  <Card title="macOS app onboarding" href="/start/onboarding">
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
