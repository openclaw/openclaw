---
summary: "Servicio integrado de control del navegador + comandos de acción"
read_when:
  - Agregar automatización del navegador controlada por el agente
  - Depurar por qué openclaw está interfiriendo con su propio Chrome
  - Implementar ajustes y ciclo de vida del navegador en la app de macOS
title: "Navegador (administrado por OpenClaw)"
---

# Navegador (administrado por openclaw)

OpenClaw puede ejecutar un **perfil dedicado de Chrome/Brave/Edge/Chromium** que el agente controla.
Está aislado de su navegador personal y se gestiona mediante un pequeño
servicio de control local dentro del Gateway (solo loopback).

Vista para principiantes:

- Piense en ello como un **navegador separado, solo para el agente**.
- El perfil `openclaw` **no** toca su perfil personal del navegador.
- El agente puede **abrir pestañas, leer páginas, hacer clic y escribir** en un entorno seguro.
- El perfil predeterminado `chrome` usa el **navegador Chromium predeterminado del sistema** a través del relay de extensiones; cambie a `openclaw` para el navegador administrado e aislado.

## Qué obtiene

- Un perfil de navegador separado llamado **openclaw** (acento naranja de forma predeterminada).
- Control determinista de pestañas (listar/abrir/enfocar/cerrar).
- Acciones del agente (clic/escribir/arrastrar/seleccionar), instantáneas, capturas de pantalla, PDFs.
- Soporte opcional para múltiples perfiles (`openclaw`, `work`, `remote`, ...).

Este navegador **no** es su navegador de uso diario. Es una superficie segura y aislada para
la automatización y verificación por agentes.

## Inicio rápido

```bash
openclaw browser --browser-profile openclaw status
openclaw browser --browser-profile openclaw start
openclaw browser --browser-profile openclaw open https://example.com
openclaw browser --browser-profile openclaw snapshot
```

Si aparece “Browser disabled”, habilítelo en la configuración (ver abajo) y reinicie el
Gateway.

## Perfiles: `openclaw` vs `chrome`

- `openclaw`: navegador administrado y aislado (no requiere extensión).
- `chrome`: relay de extensión hacia su **navegador del sistema** (requiere que la extensión de OpenClaw esté adjunta a una pestaña).

Configure `browser.defaultProfile: "openclaw"` si desea el modo administrado de forma predeterminada.

## Configuración

Los ajustes del navegador viven en `~/.openclaw/openclaw.json`.

```json5
{
  browser: {
    enabled: true, // default: true
    // cdpUrl: "http://127.0.0.1:18792", // legacy single-profile override
    remoteCdpTimeoutMs: 1500, // remote CDP HTTP timeout (ms)
    remoteCdpHandshakeTimeoutMs: 3000, // remote CDP WebSocket handshake timeout (ms)
    defaultProfile: "chrome",
    color: "#FF4500",
    headless: false,
    noSandbox: false,
    attachOnly: false,
    executablePath: "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    profiles: {
      openclaw: { cdpPort: 18800, color: "#FF4500" },
      work: { cdpPort: 18801, color: "#0066CC" },
      remote: { cdpUrl: "http://10.0.0.42:9222", color: "#00AA00" },
    },
  },
}
```

Notas:

- El servicio de control del navegador se vincula a loopback en un puerto derivado de `gateway.port`
  (predeterminado: `18791`, que es gateway + 2). El relay usa el siguiente puerto (`18792`).
- Si anula el puerto del Gateway (`gateway.port` o `OPENCLAW_GATEWAY_PORT`),
  los puertos derivados del navegador se desplazan para mantenerse en la misma “familia”.
- `cdpUrl` usa por defecto el puerto del relay cuando no se establece.
- `remoteCdpTimeoutMs` se aplica a verificaciones de alcanzabilidad CDP remotas (no loopback).
- `remoteCdpHandshakeTimeoutMs` se aplica a verificaciones de alcanzabilidad del WebSocket CDP remoto.
- `attachOnly: true` significa “nunca lanzar un navegador local; solo adjuntarse si ya está en ejecución”.
- `color` + `color` por perfil tiñen la UI del navegador para que pueda ver qué perfil está activo.
- El perfil predeterminado es `chrome` (relay de extensión). Use `defaultProfile: "openclaw"` para el navegador administrado.
- Orden de autodetección: navegador predeterminado del sistema si es Chromium; de lo contrario Chrome → Brave → Edge → Chromium → Chrome Canary.
- Los perfiles locales `openclaw` asignan automáticamente `cdpPort`/`cdpUrl` — establezca esos solo para CDP remoto.

## Usar Brave (u otro navegador basado en Chromium)

Si su navegador **predeterminado del sistema** es basado en Chromium (Chrome/Brave/Edge/etc),
OpenClaw lo usa automáticamente. Establezca `browser.executablePath` para anular
la autodetección:

Ejemplo de CLI:

```bash
openclaw config set browser.executablePath "/usr/bin/google-chrome"
```

```json5
// macOS
{
  browser: {
    executablePath: "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"
  }
}

// Windows
{
  browser: {
    executablePath: "C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe"
  }
}

// Linux
{
  browser: {
    executablePath: "/usr/bin/brave-browser"
  }
}
```

## Control local vs remoto

- **Control local (predeterminado):** el Gateway inicia el servicio de control en loopback y puede lanzar un navegador local.
- **Control remoto (host de nodo):** ejecute un host de nodo en la máquina que tiene el navegador; el Gateway proxya las acciones del navegador hacia él.
- **CDP remoto:** establezca `browser.profiles.<name>.cdpUrl` (o `browser.cdpUrl`) para
  adjuntarse a un navegador basado en Chromium remoto. En este caso, OpenClaw no lanzará un navegador local.

Las URLs de CDP remoto pueden incluir autenticación:

- Tokens de consulta (p. ej., `https://provider.example?token=<token>`)
- Autenticación HTTP Basic (p. ej., `https://user:pass@provider.example`)

OpenClaw conserva la autenticación al llamar a los endpoints `/json/*` y al conectarse
al WebSocket CDP. Prefiera variables de entorno o gestores de secretos para
los tokens en lugar de confirmarlos en archivos de configuración.

## Proxy de navegador del nodo (predeterminado sin configuración)

Si ejecuta un **host de nodo** en la máquina que tiene su navegador, OpenClaw puede
redirigir automáticamente las llamadas de herramientas del navegador a ese nodo sin ninguna configuración adicional del navegador.
Este es el camino predeterminado para gateways remotos.

Notas:

- El host del nodo expone su servidor local de control del navegador mediante un **comando proxy**.
- Los perfiles provienen de la propia configuración `browser.profiles` del nodo (igual que local).
- Desactívelo si no lo desea:
  - En el nodo: `nodeHost.browserProxy.enabled=false`
  - En el gateway: `gateway.nodes.browser.mode="off"`

## Browserless (CDP remoto alojado)

[Browserless](https://browserless.io) es un servicio Chromium alojado que expone
endpoints CDP sobre HTTPS. Puede apuntar un perfil de navegador de OpenClaw a un
endpoint regional de Browserless y autenticarse con su clave de API.

Ejemplo:

```json5
{
  browser: {
    enabled: true,
    defaultProfile: "browserless",
    remoteCdpTimeoutMs: 2000,
    remoteCdpHandshakeTimeoutMs: 4000,
    profiles: {
      browserless: {
        cdpUrl: "https://production-sfo.browserless.io?token=<BROWSERLESS_API_KEY>",
        color: "#00AA00",
      },
    },
  },
}
```

Notas:

- Reemplace `<BROWSERLESS_API_KEY>` con su token real de Browserless.
- Elija el endpoint regional que coincida con su cuenta de Browserless (consulte su documentación).

## Seguridad

Ideas clave:

- El control del navegador es solo loopback; el acceso fluye a través de la autenticación del Gateway o el emparejamiento del nodo.
- Mantenga el Gateway y cualquier host de nodo en una red privada (Tailscale); evite la exposición pública.
- Trate las URLs/tokens de CDP remoto como secretos; prefiera variables de entorno o un gestor de secretos.

Consejos para CDP remoto:

- Prefiera endpoints HTTPS y tokens de corta duración cuando sea posible.
- Evite incrustar tokens de larga duración directamente en archivos de configuración.

## Perfiles (multi-navegador)

OpenClaw admite múltiples perfiles con nombre (configuraciones de enrutamiento). Los perfiles pueden ser:

- **openclaw-managed**: una instancia dedicada de navegador basado en Chromium con su propio directorio de datos de usuario + puerto CDP
- **remote**: una URL CDP explícita (navegador basado en Chromium ejecutándose en otro lugar)
- **extension relay**: sus pestañas existentes de Chrome mediante el relay local + extensión de Chrome

Valores predeterminados:

- El perfil `openclaw` se crea automáticamente si falta.
- El perfil `chrome` está integrado para el relay de la extensión de Chrome (apunta a `http://127.0.0.1:18792` de forma predeterminada).
- Los puertos CDP locales se asignan desde **18800–18899** de forma predeterminada.
- Eliminar un perfil mueve su directorio de datos local a la Papelera.

Todos los endpoints de control aceptan `?profile=<name>`; la CLI usa `--browser-profile`.

## Relay de extensión de Chrome (use su Chrome existente)

OpenClaw también puede controlar **sus pestañas existentes de Chrome** (sin una instancia separada de Chrome “openclaw”) mediante un relay CDP local + una extensión de Chrome.

Guía completa: [Chrome extension](/tools/chrome-extension)

Flujo:

- El Gateway se ejecuta localmente (misma máquina) o un host de nodo se ejecuta en la máquina del navegador.
- Un **servidor de relay** local escucha en un loopback `cdpUrl` (predeterminado: `http://127.0.0.1:18792`).
- Usted hace clic en el ícono de la extensión **OpenClaw Browser Relay** en una pestaña para adjuntarla (no se adjunta automáticamente).
- El agente controla esa pestaña mediante la herramienta normal `browser`, seleccionando el perfil correcto.

Si el Gateway se ejecuta en otro lugar, ejecute un host de nodo en la máquina del navegador para que el Gateway pueda proxiar las acciones del navegador.

### Sesiones en sandbox

Si la sesión del agente está en sandbox, la herramienta `browser` puede usar por defecto `target="sandbox"` (navegador de sandbox).
La toma de control del relay de la extensión de Chrome requiere control del navegador del host, por lo que debe:

- ejecutar la sesión sin sandbox, o
- establecer `agents.defaults.sandbox.browser.allowHostControl: true` y usar `target="host"` al llamar a la herramienta.

### Configuración

1. Cargue la extensión (dev/unpacked):

```bash
openclaw browser extension install
```

- Chrome → `chrome://extensions` → habilite “Developer mode”
- “Load unpacked” → seleccione el directorio impreso por `openclaw browser extension path`
- Fije la extensión y luego haga clic en ella en la pestaña que desea controlar (la insignia muestra `ON`).

2. Utilícelo:

- CLI: `openclaw browser --browser-profile chrome tabs`
- Herramienta del agente: `browser` con `profile="chrome"`

Opcional: si desea un nombre o puerto de relay diferente, cree su propio perfil:

```bash
openclaw browser create-profile \
  --name my-chrome \
  --driver extension \
  --cdp-url http://127.0.0.1:18792 \
  --color "#00AA00"
```

Notas:

- Este modo se basa en Playwright-on-CDP para la mayoría de las operaciones (capturas/snapshots/acciones).
- Desacople haciendo clic nuevamente en el ícono de la extensión.

## Garantías de aislamiento

- **Directorio de datos de usuario dedicado**: nunca toca su perfil personal del navegador.
- **Puertos dedicados**: evita `9222` para prevenir colisiones con flujos de trabajo de desarrollo.
- **Control determinista de pestañas**: apunte a pestañas por `targetId`, no por “última pestaña”.

## Selección del navegador

Al lanzar localmente, OpenClaw elige el primero disponible:

1. Chrome
2. Brave
3. Edge
4. Chromium
5. Chrome Canary

Puede anularlo con `browser.executablePath`.

Plataformas:

- macOS: verifica `/Applications` y `~/Applications`.
- Linux: busca `google-chrome`, `brave`, `microsoft-edge`, `chromium`, etc.
- Windows: verifica ubicaciones comunes de instalación.

## API de control (opcional)

Solo para integraciones locales, el Gateway expone una pequeña API HTTP en loopback:

- Estado/iniciar/detener: `GET /`, `POST /start`, `POST /stop`
- Pestañas: `GET /tabs`, `POST /tabs/open`, `POST /tabs/focus`, `DELETE /tabs/:targetId`
- Snapshot/captura de pantalla: `GET /snapshot`, `POST /screenshot`
- Acciones: `POST /navigate`, `POST /act`
- Hooks: `POST /hooks/file-chooser`, `POST /hooks/dialog`
- Descargas: `POST /download`, `POST /wait/download`
- Depuración: `GET /console`, `POST /pdf`
- Depuración: `GET /errors`, `GET /requests`, `POST /trace/start`, `POST /trace/stop`, `POST /highlight`
- Red: `POST /response/body`
- Estado: `GET /cookies`, `POST /cookies/set`, `POST /cookies/clear`
- Estado: `GET /storage/:kind`, `POST /storage/:kind/set`, `POST /storage/:kind/clear`
- Ajustes: `POST /set/offline`, `POST /set/headers`, `POST /set/credentials`, `POST /set/geolocation`, `POST /set/media`, `POST /set/timezone`, `POST /set/locale`, `POST /set/device`

Todos los endpoints aceptan `?profile=<name>`.

### Requisito de Playwright

Algunas funciones (navegar/actuar/snapshot de IA/snapshot por rol, capturas de elementos, PDF) requieren
Playwright. Si Playwright no está instalado, esos endpoints devuelven un error 501
claro. Las instantáneas ARIA y las capturas básicas aún funcionan para Chrome administrado por openclaw.
Para el controlador de relay de la extensión de Chrome, las instantáneas ARIA y las capturas requieren Playwright.

Si ve `Playwright is not available in this gateway build`, instale el paquete completo de
Playwright (no `playwright-core`) y reinicie el gateway, o reinstale
OpenClaw con soporte de navegador.

#### Instalación de Playwright en Docker

Si su Gateway se ejecuta en Docker, evite `npx playwright` (conflictos de override de npm).
Use la CLI incluida:

```bash
docker compose run --rm openclaw-cli \
  node /app/node_modules/playwright-core/cli.js install chromium
```

Para persistir descargas del navegador, establezca `PLAYWRIGHT_BROWSERS_PATH` (por ejemplo,
`/home/node/.cache/ms-playwright`) y asegúrese de que `/home/node` persista mediante
`OPENCLAW_HOME_VOLUME` o un bind mount. Consulte [Docker](/install/docker).

## Cómo funciona (interno)

Flujo de alto nivel:

- Un pequeño **servidor de control** acepta solicitudes HTTP.
- Se conecta a navegadores basados en Chromium (Chrome/Brave/Edge/Chromium) mediante **CDP**.
- Para acciones avanzadas (clic/escribir/snapshot/PDF), usa **Playwright** sobre
  CDP.
- Cuando falta Playwright, solo están disponibles las operaciones que no dependen de Playwright.

Este diseño mantiene al agente en una interfaz estable y determinista mientras le permite
intercambiar navegadores y perfiles locales/remotos.

## Referencia rápida de la CLI

Todos los comandos aceptan `--browser-profile <name>` para apuntar a un perfil específico.
Todos los comandos también aceptan `--json` para salida legible por máquinas (payloads estables).

Básicos:

- `openclaw browser status`
- `openclaw browser start`
- `openclaw browser stop`
- `openclaw browser tabs`
- `openclaw browser tab`
- `openclaw browser tab new`
- `openclaw browser tab select 2`
- `openclaw browser tab close 2`
- `openclaw browser open https://example.com`
- `openclaw browser focus abcd1234`
- `openclaw browser close abcd1234`

Inspección:

- `openclaw browser screenshot`
- `openclaw browser screenshot --full-page`
- `openclaw browser screenshot --ref 12`
- `openclaw browser screenshot --ref e12`
- `openclaw browser snapshot`
- `openclaw browser snapshot --format aria --limit 200`
- `openclaw browser snapshot --interactive --compact --depth 6`
- `openclaw browser snapshot --efficient`
- `openclaw browser snapshot --labels`
- `openclaw browser snapshot --selector "#main" --interactive`
- `openclaw browser snapshot --frame "iframe#main" --interactive`
- `openclaw browser console --level error`
- `openclaw browser errors --clear`
- `openclaw browser requests --filter api --clear`
- `openclaw browser pdf`
- `openclaw browser responsebody "**/api" --max-chars 5000`

Acciones:

- `openclaw browser navigate https://example.com`
- `openclaw browser resize 1280 720`
- `openclaw browser click 12 --double`
- `openclaw browser click e12 --double`
- `openclaw browser type 23 "hello" --submit`
- `openclaw browser press Enter`
- `openclaw browser hover 44`
- `openclaw browser scrollintoview e12`
- `openclaw browser drag 10 11`
- `openclaw browser select 9 OptionA OptionB`
- `openclaw browser download e12 /tmp/report.pdf`
- `openclaw browser waitfordownload /tmp/report.pdf`
- `openclaw browser upload /tmp/file.pdf`
- `openclaw browser fill --fields '[{"ref":"1","type":"text","value":"Ada"}]'`
- `openclaw browser dialog --accept`
- `openclaw browser wait --text "Done"`
- `openclaw browser wait "#main" --url "**/dash" --load networkidle --fn "window.ready===true"`
- `openclaw browser evaluate --fn '(el) => el.textContent' --ref 7`
- `openclaw browser highlight e12`
- `openclaw browser trace start`
- `openclaw browser trace stop`

Estado:

- `openclaw browser cookies`
- `openclaw browser cookies set session abc123 --url "https://example.com"`
- `openclaw browser cookies clear`
- `openclaw browser storage local get`
- `openclaw browser storage local set theme dark`
- `openclaw browser storage session clear`
- `openclaw browser set offline on`
- `openclaw browser set headers --json '{"X-Debug":"1"}'`
- `openclaw browser set credentials user pass`
- `openclaw browser set credentials --clear`
- `openclaw browser set geo 37.7749 -122.4194 --origin "https://example.com"`
- `openclaw browser set geo --clear`
- `openclaw browser set media dark`
- `openclaw browser set timezone America/New_York`
- `openclaw browser set locale en-US`
- `openclaw browser set device "iPhone 14"`

Notas:

- `upload` y `dialog` son llamadas de **armado**; ejecútelas antes del clic/pulsación
  que dispara el selector/diálogo.
- `upload` también puede establecer entradas de archivos directamente mediante `--input-ref` o `--element`.
- `snapshot`:
  - `--format ai` (predeterminado cuando Playwright está instalado): devuelve una instantánea de IA con referencias numéricas (`aria-ref="<n>"`).
  - `--format aria`: devuelve el árbol de accesibilidad (sin referencias; solo inspección).
  - `--efficient` (o `--mode efficient`): preajuste compacto de snapshot por rol (interactivo + compacto + profundidad + maxChars menor).
  - Predeterminado de configuración (solo herramienta/CLI): establezca `browser.snapshotDefaults.mode: "efficient"` para usar instantáneas eficientes cuando el llamador no pase un modo (ver [Gateway configuration](/gateway/configuration#browser-openclaw-managed-browser)).
  - Opciones de snapshot por rol (`--interactive`, `--compact`, `--depth`, `--selector`) fuerzan un snapshot basado en roles con referencias como `ref=e12`.
  - `--frame "<iframe selector>"` delimita los snapshots por rol a un iframe (se combina con referencias de rol como `e12`).
  - `--interactive` produce una lista plana y fácil de seleccionar de elementos interactivos (mejor para dirigir acciones).
  - `--labels` agrega una captura solo del viewport con etiquetas de referencia superpuestas (imprime `MEDIA:<path>`).
- `click`/`type`/etc requieren un `ref` de `snapshot` (ya sea `12` numérico o referencia de rol `e12`).
  Los selectores CSS no se admiten intencionalmente para acciones.

## Snapshots y referencias

OpenClaw admite dos estilos de “snapshot”:

- **Snapshot de IA (referencias numéricas)**: `openclaw browser snapshot` (predeterminado; `--format ai`)
  - Salida: un snapshot de texto que incluye referencias numéricas.
  - Acciones: `openclaw browser click 12`, `openclaw browser type 23 "hello"`.
  - Internamente, la referencia se resuelve mediante `aria-ref` de Playwright.

- **Snapshot por rol (referencias de rol como `e12`)**: `openclaw browser snapshot --interactive` (o `--compact`, `--depth`, `--selector`, `--frame`)
  - Salida: una lista/árbol basado en roles con `[ref=e12]` (y `[nth=1]` opcional).
  - Acciones: `openclaw browser click e12`, `openclaw browser highlight e12`.
  - Internamente, la referencia se resuelve mediante `getByRole(...)` (más `nth()` para duplicados).
  - Agregue `--labels` para incluir una captura del viewport con etiquetas `e12` superpuestas.

Comportamiento de referencias:

- Las referencias **no son estables entre navegaciones**; si algo falla, vuelva a ejecutar `snapshot` y use una referencia nueva.
- Si el snapshot por rol se tomó con `--frame`, las referencias de rol quedan delimitadas a ese iframe hasta el siguiente snapshot por rol.

## Potenciadores de espera

Puede esperar más que solo tiempo/texto:

- Esperar URL (globs compatibles con Playwright):
  - `openclaw browser wait --url "**/dash"`
- Esperar estado de carga:
  - `openclaw browser wait --load networkidle`
- Esperar un predicado JS:
  - `openclaw browser wait --fn "window.ready===true"`
- Esperar a que un selector se vuelva visible:
  - `openclaw browser wait "#main"`

Estos se pueden combinar:

```bash
openclaw browser wait "#main" \
  --url "**/dash" \
  --load networkidle \
  --fn "window.ready===true" \
  --timeout-ms 15000
```

## Depurar workflows

Cuando una acción falla (p. ej., “not visible”, “strict mode violation”, “covered”):

1. `openclaw browser snapshot --interactive`
2. Use `click <ref>` / `type <ref>` (prefiera referencias de rol en modo interactivo)
3. Si aún falla: `openclaw browser highlight <ref>` para ver qué está apuntando Playwright
4. Si la página se comporta de forma extraña:
   - `openclaw browser errors --clear`
   - `openclaw browser requests --filter api --clear`
5. Para depuración profunda: registre un trace:
   - `openclaw browser trace start`
   - reproduzca el problema
   - `openclaw browser trace stop` (imprime `TRACE:<path>`)

## Salida JSON

`--json` es para scripting y herramientas estructuradas.

Ejemplos:

```bash
openclaw browser status --json
openclaw browser snapshot --interactive --json
openclaw browser requests --filter api --json
openclaw browser cookies --json
```

Los snapshots por rol en JSON incluyen `refs` más un pequeño bloque `stats` (líneas/caracteres/referencias/interactivo) para que las herramientas puedan razonar sobre el tamaño y la densidad del payload.

## Controles de estado y entorno

Son útiles para flujos de trabajo de “hacer que el sitio se comporte como X”:

- Cookies: `cookies`, `cookies set`, `cookies clear`
- Almacenamiento: `storage local|session get|set|clear`
- Sin conexión: `set offline on|off`
- Encabezados: `set headers --json '{"X-Debug":"1"}'` (o `--clear`)
- Autenticación básica HTTP: `set credentials user pass` (o `--clear`)
- Geolocalización: `set geo <lat> <lon> --origin "https://example.com"` (o `--clear`)
- Medios: `set media dark|light|no-preference|none`
- Zona horaria / configuración regional: `set timezone ...`, `set locale ...`
- Dispositivo / viewport:
  - `set device "iPhone 14"` (preajustes de dispositivos de Playwright)
  - `set viewport 1280 720`

## Seguridad y privacidad

- El perfil del navegador openclaw puede contener sesiones con inicio de sesión; trátelo como sensible.
- `browser act kind=evaluate` / `openclaw browser evaluate` y `wait --fn`
  ejecutan JavaScript arbitrario en el contexto de la página. La inyección de prompts puede dirigir
  esto. Desactívelo con `browser.evaluateEnabled=false` si no lo necesita.
- Para inicios de sesión y notas anti-bot (X/Twitter, etc.), consulte [Browser login + X/Twitter posting](/tools/browser-login).
- Mantenga el Gateway/host de nodo privado (solo loopback o tailnet).
- Los endpoints CDP remotos son potentes; túnelos y protéjalos.

## Solución de problemas

Para problemas específicos de Linux (especialmente Chromium snap), consulte
[Browser troubleshooting](/tools/browser-linux-troubleshooting).

## Herramientas del agente + cómo funciona el control

El agente obtiene **una herramienta** para la automatización del navegador:

- `browser` — estado/iniciar/detener/pestañas/abrir/enfocar/cerrar/snapshot/captura/navegar/actuar

Cómo se mapea:

- `browser snapshot` devuelve un árbol de UI estable (IA o ARIA).
- `browser act` usa los IDs `ref` del snapshot para hacer clic/escribir/arrastrar/seleccionar.
- `browser screenshot` captura píxeles (página completa o elemento).
- `browser` acepta:
  - `profile` para elegir un perfil de navegador con nombre (openclaw, chrome o CDP remoto).
  - `target` (`sandbox` | `host` | `node`) para seleccionar dónde vive el navegador.
  - En sesiones en sandbox, `target: "host"` requiere `agents.defaults.sandbox.browser.allowHostControl=true`.
  - Si se omite `target`: las sesiones en sandbox usan por defecto `sandbox`, las sesiones sin sandbox usan por defecto `host`.
  - Si hay un nodo con capacidad de navegador conectado, la herramienta puede auto-enrutarse a él a menos que fije `target="host"` o `target="node"`.

Esto mantiene al agente determinista y evita selectores frágiles.
