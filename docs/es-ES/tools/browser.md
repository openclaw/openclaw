---
summary: "Servicio de control de navegador integrado + comandos de acción"
read_when:
  - Agregar automatización de navegador controlada por agente
  - Depurar por qué openclaw está interfiriendo con tu propio Chrome
  - Implementar configuración de navegador + ciclo de vida en la aplicación de macOS
title: "Navegador (administrado por OpenClaw)"
---

# Navegador (administrado por openclaw)

OpenClaw puede ejecutar un **perfil dedicado de Chrome/Brave/Edge/Chromium** que el agente controla.
Está aislado de tu navegador personal y es administrado a través de un pequeño servicio de
control local dentro del Gateway (solo loopback).

Vista para principiantes:

- Piénsalo como un **navegador separado, solo para agentes**.
- El perfil `openclaw` **no** toca tu perfil de navegador personal.
- El agente puede **abrir pestañas, leer páginas, hacer clic y escribir** en un carril seguro.
- El perfil predeterminado `chrome` usa el **navegador Chromium predeterminado del sistema** mediante el
  relé de extensión; cambia a `openclaw` para el navegador administrado aislado.

## Qué obtienes

- Un perfil de navegador separado llamado **openclaw** (acento naranja por defecto).
- Control de pestañas determinista (listar/abrir/enfocar/cerrar).
- Acciones del agente (clic/escribir/arrastrar/seleccionar), snapshots, capturas de pantalla, PDFs.
- Soporte multi-perfil opcional (`openclaw`, `work`, `remote`, ...).

Este navegador **no** es tu navegador diario. Es una superficie segura y aislada para
automatización de agentes y verificación.

## Inicio rápido

```bash
openclaw browser --browser-profile openclaw status
openclaw browser --browser-profile openclaw start
openclaw browser --browser-profile openclaw open https://example.com
openclaw browser --browser-profile openclaw snapshot
```

Si obtienes "Browser disabled", habilítalo en la configuración (ver abajo) y reinicia el
Gateway.

## Perfiles: `openclaw` vs `chrome`

- `openclaw`: navegador administrado y aislado (no requiere extensión).
- `chrome`: relé de extensión a tu **navegador del sistema** (requiere que la extensión OpenClaw
  esté adjunta a una pestaña).

Establece `browser.defaultProfile: "openclaw"` si quieres modo administrado por defecto.

## Configuración

La configuración del navegador está en `~/.openclaw/openclaw.json`.

```json5
{
  browser: {
    enabled: true, // predeterminado: true
    // cdpUrl: "http://127.0.0.1:18792", // anulación heredada de perfil único
    remoteCdpTimeoutMs: 1500, // tiempo de espera HTTP CDP remoto (ms)
    remoteCdpHandshakeTimeoutMs: 3000, // tiempo de espera de handshake WebSocket CDP remoto (ms)
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
  (predeterminado: `18791`, que es gateway + 2). El relé usa el siguiente puerto (`18792`).
- Si anulas el puerto del Gateway (`gateway.port` o `OPENCLAW_GATEWAY_PORT`),
  los puertos derivados del navegador se desplazan para permanecer en la misma "familia".
- `cdpUrl` tiene como predeterminado el puerto del relé cuando no está establecido.
- `remoteCdpTimeoutMs` se aplica a verificaciones de alcance CDP remotas (no-loopback).
- `remoteCdpHandshakeTimeoutMs` se aplica a verificaciones de alcance WebSocket CDP remotas.
- `attachOnly: true` significa "nunca lanzar un navegador local; solo adjuntar si ya está ejecutándose."
- `color` + `color` por perfil tiñe la UI del navegador para que puedas ver qué perfil está activo.
- El perfil predeterminado es `chrome` (relé de extensión). Usa `defaultProfile: "openclaw"` para el navegador administrado.
- Orden de autodetección: navegador predeterminado del sistema si es basado en Chromium; de lo contrario Chrome → Brave → Edge → Chromium → Chrome Canary.
- Los perfiles locales `openclaw` auto-asignan `cdpPort`/`cdpUrl` — establece esos solo para CDP remoto.

## Usar Brave (u otro navegador basado en Chromium)

Si tu navegador **predeterminado del sistema** está basado en Chromium (Chrome/Brave/Edge/etc),
OpenClaw lo usa automáticamente. Establece `browser.executablePath` para anular
la autodetección:

Ejemplo CLI:

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

- **Control local (predeterminado):** el Gateway inicia el servicio de control loopback y puede lanzar un navegador local.
- **Control remoto (host de nodo):** ejecuta un host de nodo en la máquina que tiene el navegador; el Gateway proxea acciones del navegador hacia él.
- **CDP remoto:** establece `browser.profiles.<nombre>.cdpUrl` (o `browser.cdpUrl`) para
  adjuntar a un navegador remoto basado en Chromium. En este caso, OpenClaw no lanzará un navegador local.

Las URLs CDP remotas pueden incluir autenticación:

- Tokens de consulta (por ejemplo, `https://provider.example?token=<token>`)
- Autenticación básica HTTP (por ejemplo, `https://user:pass@provider.example`)

OpenClaw preserva la autenticación al llamar a endpoints `/json/*` y al conectarse
al WebSocket CDP. Prefiere variables de entorno o administradores de secretos para
tokens en lugar de comprometerlos en archivos de configuración.

## Proxy de navegador de nodo (predeterminado de configuración cero)

Si ejecutas un **host de nodo** en la máquina que tiene tu navegador, OpenClaw puede
enrutar automáticamente las llamadas de herramientas del navegador a ese nodo sin ninguna configuración de navegador adicional.
Esta es la ruta predeterminada para gateways remotos.

Notas:

- El host de nodo expone su servidor de control de navegador local mediante un **comando proxy**.
- Los perfiles provienen de la configuración `browser.profiles` propia del nodo (igual que local).
- Deshabilita si no lo quieres:
  - En el nodo: `nodeHost.browserProxy.enabled=false`
  - En el gateway: `gateway.nodes.browser.mode="off"`

## Browserless (CDP remoto alojado)

[Browserless](https://browserless.io) es un servicio de Chromium alojado que expone
endpoints CDP sobre HTTPS. Puedes apuntar un perfil de navegador de OpenClaw a un
endpoint de región de Browserless y autenticar con tu clave de API.

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

- Reemplaza `<BROWSERLESS_API_KEY>` con tu token real de Browserless.
- Elige el endpoint de región que coincida con tu cuenta de Browserless (ver sus documentos).

## Seguridad

Ideas clave:

- El control del navegador es solo loopback; el acceso fluye a través de la autenticación del Gateway o el emparejamiento de nodos.
- Si el control del navegador está habilitado y no hay autenticación configurada, OpenClaw auto-genera `gateway.auth.token` al inicio y lo persiste en la configuración.
- Mantén el Gateway y cualquier host de nodo en una red privada (Tailscale); evita la exposición pública.
- Trata las URLs/tokens CDP remotas como secretos; prefiere variables de entorno o un administrador de secretos.

Consejos de CDP remoto:

- Prefiere endpoints HTTPS y tokens de corta duración cuando sea posible.
- Evita incrustar tokens de larga duración directamente en archivos de configuración.

## Perfiles (multi-navegador)

OpenClaw admite múltiples perfiles nombrados (configuraciones de enrutamiento). Los perfiles pueden ser:

- **administrados por openclaw**: una instancia de navegador basada en Chromium dedicada con su propio directorio de datos de usuario + puerto CDP
- **remoto**: una URL CDP explícita (navegador basado en Chromium ejecutándose en otro lugar)
- **relé de extensión**: tu(s) pestaña(s) existente(s) de Chrome mediante el relé local + extensión de Chrome

Predeterminados:

- El perfil `openclaw` se auto-crea si falta.
- El perfil `chrome` está integrado para el relé de extensión de Chrome (apunta a `http://127.0.0.1:18792` por defecto).
- Los puertos CDP locales se asignan desde **18800–18899** por defecto.
- Eliminar un perfil mueve su directorio de datos local a la Papelera.

Todos los endpoints de control aceptan `?profile=<nombre>`; el CLI usa `--browser-profile`.

## Relé de extensión de Chrome (usa tu Chrome existente)

OpenClaw también puede controlar **tus pestañas existentes de Chrome** (sin instancia "openclaw" de Chrome separada) mediante un relé CDP local + una extensión de Chrome.

Guía completa: [Extensión de Chrome](/es-ES/tools/chrome-extension)

Flujo:

- El Gateway se ejecuta localmente (misma máquina) o un host de nodo se ejecuta en la máquina del navegador.
- Un **servidor de relé** local escucha en un `cdpUrl` loopback (predeterminado: `http://127.0.0.1:18792`).
- Haces clic en el icono de la extensión **OpenClaw Browser Relay** en una pestaña para adjuntar (no se adjunta automáticamente).
- El agente controla esa pestaña mediante la herramienta `browser` normal, seleccionando el perfil correcto.

Si el Gateway se ejecuta en otro lugar, ejecuta un host de nodo en la máquina del navegador para que el Gateway pueda proxear acciones del navegador.

### Sesiones en sandbox

Si la sesión del agente está en sandbox, la herramienta `browser` puede tener como predeterminado `target="sandbox"` (navegador sandbox).
La toma de control del relé de extensión de Chrome requiere control de navegador del host, así que:

- ejecuta la sesión sin sandbox, o
- establece `agents.defaults.sandbox.browser.allowHostControl: true` y usa `target="host"` al llamar a la herramienta.

### Configuración

1. Carga la extensión (dev/desempaquetada):

```bash
openclaw browser extension install
```

- Chrome → `chrome://extensions` → habilita "Modo de desarrollador"
- "Cargar extensión sin empaquetar" → selecciona el directorio impreso por `openclaw browser extension path`
- Fija la extensión, luego haz clic en ella en la pestaña que deseas controlar (la insignia muestra `ON`).

2. Úsala:

- CLI: `openclaw browser --browser-profile chrome tabs`
- Herramienta de agente: `browser` con `profile="chrome"`

Opcional: si quieres un nombre diferente o puerto de relé, crea tu propio perfil:

```bash
openclaw browser create-profile \
  --name my-chrome \
  --driver extension \
  --cdp-url http://127.0.0.1:18792 \
  --color "#00AA00"
```

Notas:

- Este modo depende de Playwright-sobre-CDP para la mayoría de las operaciones (capturas de pantalla/snapshots/acciones).
- Desadjunta haciendo clic en el icono de la extensión nuevamente.

## Garantías de aislamiento

- **Directorio de datos de usuario dedicado**: nunca toca tu perfil de navegador personal.
- **Puertos dedicados**: evita `9222` para prevenir colisiones con flujos de trabajo de desarrollo.
- **Control de pestañas determinista**: apunta a pestañas por `targetId`, no "última pestaña".

## Selección de navegador

Al lanzar localmente, OpenClaw elige el primero disponible:

1. Chrome
2. Brave
3. Edge
4. Chromium
5. Chrome Canary

Puedes anular con `browser.executablePath`.

Plataformas:

- macOS: verifica `/Applications` y `~/Applications`.
- Linux: busca `google-chrome`, `brave`, `microsoft-edge`, `chromium`, etc.
- Windows: verifica ubicaciones de instalación comunes.

## API de control (opcional)

Solo para integraciones locales, el Gateway expone una pequeña API HTTP loopback:

- Status/start/stop: `GET /`, `POST /start`, `POST /stop`
- Tabs: `GET /tabs`, `POST /tabs/open`, `POST /tabs/focus`, `DELETE /tabs/:targetId`
- Snapshot/screenshot: `GET /snapshot`, `POST /screenshot`
- Actions: `POST /navigate`, `POST /act`
- Hooks: `POST /hooks/file-chooser`, `POST /hooks/dialog`
- Downloads: `POST /download`, `POST /wait/download`
- Debugging: `GET /console`, `POST /pdf`
- Debugging: `GET /errors`, `GET /requests`, `POST /trace/start`, `POST /trace/stop`, `POST /highlight`
- Network: `POST /response/body`
- State: `GET /cookies`, `POST /cookies/set`, `POST /cookies/clear`
- State: `GET /storage/:kind`, `POST /storage/:kind/set`, `POST /storage/:kind/clear`
- Settings: `POST /set/offline`, `POST /set/headers`, `POST /set/credentials`, `POST /set/geolocation`, `POST /set/media`, `POST /set/timezone`, `POST /set/locale`, `POST /set/device`

Todos los endpoints aceptan `?profile=<nombre>`.

Si la autenticación del gateway está configurada, las rutas HTTP del navegador también requieren autenticación:

- `Authorization: Bearer <token del gateway>`
- `x-openclaw-password: <contraseña del gateway>` o autenticación básica HTTP con esa contraseña

### Requisito de Playwright

Algunas características (navigate/act/snapshot AI/role snapshot, capturas de pantalla de elementos, PDF) requieren
Playwright. Si Playwright no está instalado, esos endpoints devuelven un error 501
claro. Los snapshots ARIA y capturas de pantalla básicas aún funcionan para Chrome administrado por openclaw.
Para el controlador de relé de extensión de Chrome, los snapshots ARIA y capturas de pantalla requieren Playwright.

Si ves `Playwright is not available in this gateway build`, instala el paquete completo
de Playwright (no `playwright-core`) y reinicia el gateway, o reinstala
OpenClaw con soporte de navegador.

#### Instalación de Playwright en Docker

Si tu Gateway se ejecuta en Docker, evita `npx playwright` (conflictos de anulación npm).
Usa el CLI incluido en su lugar:

```bash
docker compose run --rm openclaw-cli \
  node /app/node_modules/playwright-core/cli.js install chromium
```

Para persistir descargas del navegador, establece `PLAYWRIGHT_BROWSERS_PATH` (por ejemplo,
`/home/node/.cache/ms-playwright`) y asegúrate de que `/home/node` se persista mediante
`OPENCLAW_HOME_VOLUME` o un bind mount. Ver [Docker](/es-ES/install/docker).

## Cómo funciona (interno)

Flujo de alto nivel:

- Un pequeño **servidor de control** acepta solicitudes HTTP.
- Se conecta a navegadores basados en Chromium (Chrome/Brave/Edge/Chromium) mediante **CDP**.
- Para acciones avanzadas (clic/escribir/snapshot/PDF), usa **Playwright** sobre
  CDP.
- Cuando falta Playwright, solo las operaciones no-Playwright están disponibles.

Este diseño mantiene al agente en una interfaz estable y determinista mientras te permite
intercambiar navegadores y perfiles locales/remotos.

## Referencia rápida de CLI

Todos los comandos aceptan `--browser-profile <nombre>` para apuntar a un perfil específico.
Todos los comandos también aceptan `--json` para salida legible por máquina (cargas estables).

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
- `openclaw browser download e12 report.pdf`
- `openclaw browser waitfordownload report.pdf`
- `openclaw browser upload /tmp/openclaw/uploads/file.pdf`
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

- `upload` y `dialog` son llamadas de **armado**; ejecútalas antes del clic/presión
  que activa el selector/diálogo.
- Las rutas de salida de descarga y traza están restringidas a raíces temporales de OpenClaw:
  - trazas: `/tmp/openclaw` (alternativa: `${os.tmpdir()}/openclaw`)
  - descargas: `/tmp/openclaw/downloads` (alternativa: `${os.tmpdir()}/openclaw/downloads`)
- Las rutas de carga están restringidas a una raíz temporal de cargas de OpenClaw:
  - cargas: `/tmp/openclaw/uploads` (alternativa: `${os.tmpdir()}/openclaw/uploads`)
- `upload` también puede establecer entradas de archivo directamente mediante `--input-ref` o `--element`.
- `snapshot`:
  - `--format ai` (predeterminado cuando Playwright está instalado): devuelve un snapshot AI con refs numéricos (`aria-ref="<n>"`).
  - `--format aria`: devuelve el árbol de accesibilidad (sin refs; solo inspección).
  - `--efficient` (o `--mode efficient`): preajuste de role snapshot compacto (interactive + compact + depth + maxChars inferior).
  - Config predeterminado (solo herramienta/CLI): establece `browser.snapshotDefaults.mode: "efficient"` para usar snapshots eficientes cuando el llamador no pase un modo (ver [Configuración del Gateway](/es-ES/gateway/configuration#browser-openclaw-managed-browser)).
  - Opciones de role snapshot (`--interactive`, `--compact`, `--depth`, `--selector`) fuerzan un snapshot basado en rol con refs como `ref=e12`.
  - `--frame "<selector de iframe>"` alcanza role snapshots a un iframe (se empareja con role refs como `e12`).
  - `--interactive` produce una lista plana y fácil de elegir de elementos interactivos (mejor para conducir acciones).
  - `--labels` agrega una captura de pantalla solo del viewport con etiquetas ref superpuestas (imprime `MEDIA:<ruta>`).
- `click`/`type`/etc requieren un `ref` de `snapshot` (ya sea numérico `12` o role ref `e12`).
  Los selectores CSS intencionalmente no son compatibles para acciones.

## Snapshots y refs

OpenClaw admite dos estilos de "snapshot":

- **Snapshot AI (refs numéricos)**: `openclaw browser snapshot` (predeterminado; `--format ai`)
  - Salida: un snapshot de texto que incluye refs numéricos.
  - Acciones: `openclaw browser click 12`, `openclaw browser type 23 "hello"`.
  - Internamente, el ref se resuelve mediante `aria-ref` de Playwright.

- **Role snapshot (role refs como `e12`)**: `openclaw browser snapshot --interactive` (o `--compact`, `--depth`, `--selector`, `--frame`)
  - Salida: una lista/árbol basado en roles con `[ref=e12]` (y `[nth=1]` opcional).
  - Acciones: `openclaw browser click e12`, `openclaw browser highlight e12`.
  - Internamente, el ref se resuelve mediante `getByRole(...)` (más `nth()` para duplicados).
  - Agrega `--labels` para incluir una captura de pantalla del viewport con etiquetas `e12` superpuestas.

Comportamiento de ref:

- Los refs **no son estables entre navegaciones**; si algo falla, vuelve a ejecutar `snapshot` y usa un ref fresco.
- Si el role snapshot se tomó con `--frame`, los role refs están limitados a ese iframe hasta el siguiente role snapshot.

## Potenciadores de Wait

Puedes esperar más que solo tiempo/texto:

- Esperar URL (globs compatibles con Playwright):
  - `openclaw browser wait --url "**/dash"`
- Esperar estado de carga:
  - `openclaw browser wait --load networkidle`
- Esperar un predicado JS:
  - `openclaw browser wait --fn "window.ready===true"`
- Esperar que un selector se vuelva visible:
  - `openclaw browser wait "#main"`

Estos se pueden combinar:

```bash
openclaw browser wait "#main" \
  --url "**/dash" \
  --load networkidle \
  --fn "window.ready===true" \
  --timeout-ms 15000
```

## Flujos de trabajo de depuración

Cuando una acción falla (por ejemplo, "not visible", "strict mode violation", "covered"):

1. `openclaw browser snapshot --interactive`
2. Usa `click <ref>` / `type <ref>` (prefiere role refs en modo interactivo)
3. Si aún falla: `openclaw browser highlight <ref>` para ver qué está apuntando Playwright
4. Si la página se comporta extraño:
   - `openclaw browser errors --clear`
   - `openclaw browser requests --filter api --clear`
5. Para depuración profunda: graba una traza:
   - `openclaw browser trace start`
   - reproduce el problema
   - `openclaw browser trace stop` (imprime `TRACE:<ruta>`)

## Salida JSON

`--json` es para scripting y herramientas estructuradas.

Ejemplos:

```bash
openclaw browser status --json
openclaw browser snapshot --interactive --json
openclaw browser requests --filter api --json
openclaw browser cookies --json
```

Los role snapshots en JSON incluyen `refs` más un pequeño bloque `stats` (líneas/caracteres/refs/interactivo) para que las herramientas puedan razonar sobre el tamaño de carga y la densidad.

## Controles de estado y entorno

Estos son útiles para flujos de trabajo de "hacer que el sitio se comporte como X":

- Cookies: `cookies`, `cookies set`, `cookies clear`
- Storage: `storage local|session get|set|clear`
- Offline: `set offline on|off`
- Headers: `set headers --json '{"X-Debug":"1"}'` (o `--clear`)
- Autenticación básica HTTP: `set credentials user pass` (o `--clear`)
- Geolocalización: `set geo <lat> <lon> --origin "https://example.com"` (o `--clear`)
- Media: `set media dark|light|no-preference|none`
- Timezone / locale: `set timezone ...`, `set locale ...`
- Device / viewport:
  - `set device "iPhone 14"` (preajustes de dispositivo de Playwright)
  - `set viewport 1280 720`

## Seguridad y privacidad

- El perfil del navegador openclaw puede contener sesiones iniciadas; trátalo como sensible.
- `browser act kind=evaluate` / `openclaw browser evaluate` y `wait --fn`
  ejecutan JavaScript arbitrario en el contexto de la página. La inyección de prompts puede dirigir
  esto. Deshabilítalo con `browser.evaluateEnabled=false` si no lo necesitas.
- Para inicios de sesión y notas anti-bot (X/Twitter, etc.), ver [Inicio de sesión de navegador + publicación en X/Twitter](/es-ES/tools/browser-login).
- Mantén el Gateway/host de nodo privado (solo loopback o tailnet).
- Los endpoints CDP remotos son poderosos; crea túneles y protégelos.

## Solución de problemas

Para problemas específicos de Linux (especialmente snap Chromium), ver
[Solución de problemas del navegador](/es-ES/tools/browser-linux-troubleshooting).

## Herramientas de agente + cómo funciona el control

El agente obtiene **una herramienta** para automatización del navegador:

- `browser` — status/start/stop/tabs/open/focus/close/snapshot/screenshot/navigate/act

Cómo se mapea:

- `browser snapshot` devuelve un árbol UI estable (AI o ARIA).
- `browser act` usa los IDs `ref` del snapshot para clic/escribir/arrastrar/seleccionar.
- `browser screenshot` captura píxeles (página completa o elemento).
- `browser` acepta:
  - `profile` para elegir un perfil de navegador nombrado (openclaw, chrome o CDP remoto).
  - `target` (`sandbox` | `host` | `node`) para seleccionar dónde vive el navegador.
  - En sesiones en sandbox, `target: "host"` requiere `agents.defaults.sandbox.browser.allowHostControl=true`.
  - Si se omite `target`: las sesiones en sandbox tienen como predeterminado `sandbox`, las sesiones sin sandbox tienen como predeterminado `host`.
  - Si un nodo con capacidad de navegador está conectado, la herramienta puede enrutar automáticamente hacia él a menos que fijes `target="host"` o `target="node"`.

Esto mantiene al agente determinista y evita selectores frágiles.
