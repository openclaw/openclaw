---
title: "Extensión de Chrome"
description: "Integra OpenClaw con tu navegador Chrome"
---

## Descripción General

La Extensión de Chrome de OpenClaw te permite interactuar con OpenClaw directamente desde tu navegador. Habilita:

- **Captura de contenido web**: Captura contenido de página para análisis por agentes
- **Automatización del navegador**: Desencadena acciones de agentes desde el navegador
- **Integración de contexto**: Comparte contexto del navegador con sesiones de agentes
- **Atajos de teclado**: Acceso rápido a funciones de OpenClaw

## Instalación

### Desde Chrome Web Store

1. Visita [Chrome Web Store](https://chrome.google.com/webstore)
2. Busca "OpenClaw"
3. Haz clic en "Agregar a Chrome"
4. Confirma los permisos cuando se te solicite

### Instalación Manual (Desarrollo)

1. Descarga el código fuente de la extensión:

   ```bash
   git clone https://github.com/openclaw/chrome-extension
   cd chrome-extension
   npm install
   npm run build
   ```

2. Carga la extensión en Chrome:
   - Abre Chrome y navega a `chrome://extensions`
   - Habilita "Modo de desarrollador" (esquina superior derecha)
   - Haz clic en "Cargar extensión sin empaquetar"
   - Selecciona el directorio `dist/` del proyecto clonado

## Configuración

### Conectar a tu Gateway

1. Haz clic en el ícono de la extensión de OpenClaw en tu barra de herramientas
2. Haz clic en "Configuración"
3. Ingresa la URL de tu Gateway (ej. `http://localhost:18789`)
4. Haz clic en "Conectar"

### Verificar Conexión

Una vez conectado, deberías ver un indicador de estado verde en el popup de la extensión.

## Características

### Captura de Página

Captura el contenido de la página actual y envíalo a OpenClaw para análisis:

1. Navega a cualquier página web
2. Haz clic en el ícono de la extensión de OpenClaw
3. Haz clic en "Capturar Página"
4. El contenido de la página se enviará a tu agente de OpenClaw

**Atajo de teclado**: `Ctrl+Shift+C` (Windows/Linux) o `Cmd+Shift+C` (Mac)

### Captura de Selección

Captura solo el texto o contenido seleccionado:

1. Selecciona texto o contenido en cualquier página web
2. Haz clic derecho y selecciona "Enviar a OpenClaw"
3. O usa el atajo de teclado: `Ctrl+Shift+S`

### Ejecución de Comandos

Ejecuta comandos de OpenClaw directamente desde el navegador:

1. Haz clic en el ícono de la extensión
2. Escribe un comando en el campo de entrada
3. Presiona Enter o haz clic en "Enviar"

### Integración de Contexto

La extensión comparte automáticamente el contexto del navegador con OpenClaw:

- URL actual
- Título de la página
- Texto seleccionado
- Pestaña activa
- Historial de navegación (si está habilitado)

## Permisos

La extensión requiere los siguientes permisos:

| Permiso        | Propósito                                             |
| -------------- | ----------------------------------------------------- |
| `activeTab`    | Acceder al contenido de la pestaña actual             |
| `storage`      | Guardar configuración de la extensión                 |
| `contextMenus` | Agregar elementos de menú de contexto de clic derecho |
| `<all_urls>`   | Conectarse a tu Gateway de OpenClaw                   |

## Privacidad

- La extensión solo se comunica con tu Gateway local de OpenClaw
- No se envían datos a servidores externos
- Todo el procesamiento ocurre localmente o en tu Gateway configurado
- Puedes revisar el código fuente en [GitHub](https://github.com/openclaw/chrome-extension)

## Solución de Problemas

### La Extensión No Se Conecta al Gateway

1. Verifica que tu Gateway de OpenClaw esté en ejecución:

   ```bash
   openclaw gateway status
   ```

2. Confirma la URL del Gateway en la configuración de la extensión
3. Verifica los ajustes de firewall que puedan estar bloqueando la conexión
4. Revisa la consola del navegador en busca de errores (F12 → Consola)

### La Captura de Página No Funciona

1. Verifica que tengas un agente activo en OpenClaw
2. Asegúrate de que la página haya terminado de cargar completamente
3. Algunas páginas pueden tener restricciones que previenen la captura de contenido
4. Intenta refrescar la página y volver a intentar

### Los Atajos de Teclado No Funcionan

1. Ve a `chrome://extensions/shortcuts`
2. Busca "OpenClaw"
3. Configura o verifica tus atajos de teclado preferidos
4. Asegúrate de que los atajos no entren en conflicto con otras extensiones

## Desarrollo

### Construir desde el Código Fuente

```bash
# Clonar el repositorio
git clone https://github.com/openclaw/chrome-extension
cd chrome-extension

# Instalar dependencias
npm install

# Desarrollo con recarga en vivo
npm run dev

# Construir para producción
npm run build
```

### Estructura del Proyecto

```
chrome-extension/
├── src/
│   ├── background/     # Service worker de fondo
│   ├── content/        # Scripts de contenido inyectados en páginas
│   ├── popup/          # UI del popup de la extensión
│   └── options/        # Página de configuración
├── public/
│   ├── manifest.json   # Archivo manifest de la extensión
│   └── icons/          # Íconos de la extensión
└── dist/               # Salida de construcción
```

### Contribuir

¿Encontraste un error o tienes una idea de función? Contribuye en [GitHub](https://github.com/openclaw/chrome-extension)!

## Soporte

Para ayuda con la extensión de Chrome:

- [Documentación](https://docs.openclaw.ai/es-ES/tools/chrome-extension)
- [GitHub Issues](https://github.com/openclaw/chrome-extension/issues)
- [Comunidad de Discord](https://discord.gg/openclaw)
