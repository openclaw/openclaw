---
summary: "Instala OpenClaw y ejecuta tu primer chat en minutos."
read_when:
  - Configuración inicial desde cero
  - Quieres el camino más rápido a un chat funcional
title: "Comenzando"
---

# Comenzando

Objetivo: ir de cero a un primer chat funcional con configuración mínima.

<Info>
Chat más rápido: abre la interfaz de control (no se necesita configuración de canal). Ejecuta `openclaw dashboard`
y chatea en el navegador, o abre `http://127.0.0.1:18789/` en el
<Tooltip headline="Host del gateway" tip="La máquina que ejecuta el servicio gateway de OpenClaw.">host del gateway</Tooltip>.
Documentación: [Panel de Control](/web/dashboard) e [Interfaz de Control](/web/control-ui).
</Info>

## Prerrequisitos

- Node 22 o más reciente

<Tip>
Verifica tu versión de Node con `node --version` si no estás seguro.
</Tip>

## Configuración rápida (CLI)

<Steps>
  <Step title="Instalar OpenClaw (recomendado)">
    <Tabs>
      <Tab title="macOS/Linux">
        ```bash
        curl -fsSL https://openclaw.ai/install.sh | bash
        ```
        <img
  src="/assets/install-script.svg"
  alt="Proceso del Script de Instalación"
  className="rounded-lg"
/>
      </Tab>
      <Tab title="Windows (PowerShell)">
        ```powershell
        iwr -useb https://openclaw.ai/install.ps1 | iex
        ```
      </Tab>
    </Tabs>

    <Note>
    Otros métodos de instalación y requisitos: [Instalación](/install).
    </Note>

  </Step>
  <Step title="Ejecutar el asistente de incorporación">
    ```bash
    openclaw onboard --install-daemon
    ```

    El asistente configura autenticación, ajustes del gateway y canales opcionales.
    Consulta [Asistente de Incorporación](/start/wizard) para más detalles.

  </Step>
  <Step title="Verificar el Gateway">
    Si instalaste el servicio, debería estar ya ejecutándose:

    ```bash
    openclaw gateway status
    ```

  </Step>
  <Step title="Abrir la Interfaz de Control">
    ```bash
    openclaw dashboard
    ```
  </Step>
</Steps>

<Check>
Si la Interfaz de Control se carga, tu Gateway está listo para usar.
</Check>

## Verificaciones opcionales y extras

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
    openclaw message send --target +15555550123 --message "Hola desde OpenClaw"
    ```

  </Accordion>
</AccordionGroup>

## Variables de entorno útiles

Si ejecutas OpenClaw como cuenta de servicio o quieres ubicaciones personalizadas de configuración/estado:

- `OPENCLAW_HOME` establece el directorio home usado para la resolución de rutas internas.
- `OPENCLAW_STATE_DIR` sobrescribe el directorio de estado.
- `OPENCLAW_CONFIG_PATH` sobrescribe la ruta del archivo de configuración.

Referencia completa de variables de entorno: [Variables de entorno](/help/environment).

## Profundizar más

<Columns>
  <Card title="Asistente de Incorporación (detalles)" href="/start/wizard">
    Referencia completa del asistente CLI y opciones avanzadas.
  </Card>
  <Card title="Incorporación de la app macOS" href="/start/onboarding">
    Flujo de primera ejecución para la aplicación macOS.
  </Card>
</Columns>

## Lo que tendrás

- Un Gateway en ejecución
- Autenticación configurada
- Acceso a la Interfaz de Control o un canal conectado

## Siguientes pasos

- Seguridad en mensajes directos y aprobaciones: [Emparejamiento](/channels/pairing)
- Conectar más canales: [Canales](/channels)
- Flujos de trabajo avanzados y desde código fuente: [Configuración](/start/setup)
