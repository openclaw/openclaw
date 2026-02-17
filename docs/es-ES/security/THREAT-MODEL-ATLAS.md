# Modelo de Amenazas de OpenClaw v1.0

## Framework MITRE ATLAS

**Versión:** 1.0-draft
**Última Actualización:** 2026-02-04
**Metodología:** MITRE ATLAS + Diagramas de Flujo de Datos
**Framework:** [MITRE ATLAS](https://atlas.mitre.org/) (Adversarial Threat Landscape for AI Systems)

### Atribución del Framework

Este modelo de amenazas está construido sobre [MITRE ATLAS](https://atlas.mitre.org/), el framework estándar de la industria para documentar amenazas adversariales a sistemas de IA/ML. ATLAS es mantenido por [MITRE](https://www.mitre.org/) en colaboración con la comunidad de seguridad de IA.

**Recursos Clave de ATLAS:**

- [Técnicas de ATLAS](https://atlas.mitre.org/techniques/)
- [Tácticas de ATLAS](https://atlas.mitre.org/tactics/)
- [Estudios de Caso de ATLAS](https://atlas.mitre.org/studies/)
- [GitHub de ATLAS](https://github.com/mitre-atlas/atlas-data)
- [Contribuir a ATLAS](https://atlas.mitre.org/resources/contribute)

### Contribuir a Este Modelo de Amenazas

Este es un documento vivo mantenido por la comunidad de OpenClaw. Consulta [CONTRIBUTING-THREAT-MODEL.md](./CONTRIBUTING-THREAT-MODEL.md) para obtener pautas sobre cómo contribuir:

- Reportar nuevas amenazas
- Actualizar amenazas existentes
- Proponer cadenas de ataque
- Sugerir mitigaciones

---

## 1. Introducción

### 1.1 Propósito

Este modelo de amenazas documenta las amenazas adversariales a la plataforma de agentes de IA OpenClaw y el mercado de habilidades ClawHub, utilizando el framework MITRE ATLAS diseñado específicamente para sistemas de IA/ML.

### 1.2 Alcance

| Componente              | Incluido | Notas                                            |
| ----------------------- | -------- | ------------------------------------------------ |
| Runtime de Agente OpenClaw | Sí    | Ejecución de agente principal, llamadas de herramientas, sesiones |
| Gateway                 | Sí       | Autenticación, enrutamiento, integración de canales |
| Integraciones de Canales | Sí      | WhatsApp, Telegram, Discord, Signal, Slack, etc. |
| Mercado ClawHub         | Sí       | Publicación de habilidades, moderación, distribución |
| Servidores MCP          | Sí       | Proveedores de herramientas externos             |
| Dispositivos de Usuario | Parcial  | Aplicaciones móviles, clientes de escritorio     |

### 1.3 Fuera de Alcance

Nada está explícitamente fuera del alcance de este modelo de amenazas.

---

## 2. Arquitectura del Sistema

### 2.1 Límites de Confianza

```
┌─────────────────────────────────────────────────────────────────┐
│                    ZONA NO CONFIABLE                             │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐              │
│  │  WhatsApp   │  │  Telegram   │  │   Discord   │  ...         │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘              │
│         │                │                │                      │
└─────────┼────────────────┼────────────────┼──────────────────────┘
          │                │                │
          ▼                ▼                ▼
┌─────────────────────────────────────────────────────────────────┐
│              LÍMITE DE CONFIANZA 1: Acceso al Canal              │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │                      GATEWAY                              │   │
│  │  • Emparejamiento de Dispositivos (período de gracia 30s) │   │
│  │  • Validación de AllowFrom / AllowList                    │   │
│  │  • Autenticación Token/Password/Tailscale                 │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│              LÍMITE DE CONFIANZA 2: Aislamiento de Sesión       │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │                   SESIONES DE AGENTE                      │   │
│  │  • Clave de sesión = agent:channel:peer                   │   │
│  │  • Políticas de herramientas por agente                   │   │
│  │  • Registro de transcripciones                            │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│              LÍMITE DE CONFIANZA 3: Ejecución de Herramientas   │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │                  SANDBOX DE EJECUCIÓN                     │   │
│  │  • Sandbox Docker O Host (exec-approvals)                 │   │
│  │  • Ejecución remota de nodo                               │   │
│  │  • Protección SSRF (fijación DNS + bloqueo de IP)         │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│              LÍMITE DE CONFIANZA 4: Contenido Externo            │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │        URLs OBTENIDAS / EMAILS / WEBHOOKS                 │   │
│  │  • Envoltorio de contenido externo (etiquetas XML)        │   │
│  │  • Inyección de aviso de seguridad                        │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│              LÍMITE DE CONFIANZA 5: Cadena de Suministro         │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │                      CLAWHUB                              │   │
│  │  • Publicación de habilidades (semver, SKILL.md requerido) │   │
│  │  • Indicadores de moderación basados en patrones          │   │
│  │  • Escaneo de VirusTotal (próximamente)                   │   │
│  │  • Verificación de antigüedad de cuenta GitHub            │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

### 2.2 Flujos de Datos

| Flujo | Origen  | Destino | Datos               | Protección           |
| ----- | ------- | ------- | ------------------- | -------------------- |
| F1    | Canal   | Gateway | Mensajes de usuario | TLS, AllowFrom       |
| F2    | Gateway | Agente  | Mensajes enrutados  | Aislamiento de sesión |
| F3    | Agente  | Herramientas | Invocaciones de herramientas | Aplicación de políticas |
| F4    | Agente  | Externo | Solicitudes web_fetch | Bloqueo SSRF      |
| F5    | ClawHub | Agente  | Código de habilidad | Moderación, escaneo  |
| F6    | Agente  | Canal   | Respuestas          | Filtrado de salida   |

---

## 3. Análisis de Amenazas por Táctica ATLAS

### 3.1 Reconocimiento (AML.TA0002)

#### T-RECON-001: Descubrimiento de Endpoint de Agente

| Atributo                | Valor                                                                |
| ----------------------- | -------------------------------------------------------------------- |
| **ID ATLAS**            | AML.T0006 - Escaneo Activo                                           |
| **Descripción**         | El atacante escanea en busca de endpoints de gateway OpenClaw expuestos |
| **Vector de Ataque**    | Escaneo de red, consultas shodan, enumeración DNS                    |
| **Componentes Afectados** | Gateway, endpoints de API expuestos                                |
| **Mitigaciones Actuales** | Opción de autenticación Tailscale, enlazar a bucle local por defecto |
| **Riesgo Residual**     | Medio - Gateways públicos detectables                                |
| **Recomendaciones**     | Documentar despliegue seguro, agregar limitación de tasa en endpoints de descubrimiento |

#### T-RECON-002: Sondeo de Integración de Canal

| Atributo                | Valor                                                              |
| ----------------------- | ------------------------------------------------------------------ |
| **ID ATLAS**            | AML.T0006 - Escaneo Activo                                         |
| **Descripción**         | El atacante sondea canales de mensajería para identificar cuentas gestionadas por IA |
| **Vector de Ataque**    | Enviar mensajes de prueba, observar patrones de respuesta          |
| **Componentes Afectados** | Todas las integraciones de canales                               |
| **Mitigaciones Actuales** | Ninguna específica                                               |
| **Riesgo Residual**     | Bajo - Valor limitado solo del descubrimiento                      |
| **Recomendaciones**     | Considerar aleatorización del tiempo de respuesta                  |

---

### 3.2 Acceso Inicial (AML.TA0004)

#### T-ACCESS-001: Intercepción de Código de Emparejamiento

| Atributo                | Valor                                                    |
| ----------------------- | -------------------------------------------------------- |
| **ID ATLAS**            | AML.T0040 - Acceso a API de Inferencia de Modelo de IA  |
| **Descripción**         | El atacante intercepta el código de emparejamiento durante el período de gracia de 30s |
| **Vector de Ataque**    | Observación sobre el hombro, esnifado de red, ingeniería social |
| **Componentes Afectados** | Sistema de emparejamiento de dispositivos              |
| **Mitigaciones Actuales** | Expiración de 30s, códigos enviados vía canal existente |
| **Riesgo Residual**     | Medio - Período de gracia explotable                     |
| **Recomendaciones**     | Reducir período de gracia, agregar paso de confirmación |

#### T-ACCESS-002: Suplantación de AllowFrom

| Atributo                | Valor                                                                          |
| ----------------------- | ------------------------------------------------------------------------------ |
| **ID ATLAS**            | AML.T0040 - Acceso a API de Inferencia de Modelo de IA                         |
| **Descripción**         | El atacante suplanta la identidad del remitente permitido en el canal          |
| **Vector de Ataque**    | Depende del canal - suplantación de número telefónico, suplantación de nombre de usuario |
| **Componentes Afectados** | Validación de AllowFrom por canal                                            |
| **Mitigaciones Actuales** | Verificación de identidad específica del canal                               |
| **Riesgo Residual**     | Medio - Algunos canales vulnerables a la suplantación                          |
| **Recomendaciones**     | Documentar riesgos específicos del canal, agregar verificación criptográfica donde sea posible |

#### T-ACCESS-003: Robo de Token

| Atributo                | Valor                                                       |
| ----------------------- | ----------------------------------------------------------- |
| **ID ATLAS**            | AML.T0040 - Acceso a API de Inferencia de Modelo de IA     |
| **Descripción**         | El atacante roba tokens de autenticación de archivos de configuración |
| **Vector de Ataque**    | Malware, acceso no autorizado al dispositivo, exposición de respaldo de configuración |
| **Componentes Afectados** | ~/.openclaw/credentials/, almacenamiento de configuración |
| **Mitigaciones Actuales** | Permisos de archivo                                       |
| **Riesgo Residual**     | Alto - Tokens almacenados en texto plano                    |
| **Recomendaciones**     | Implementar cifrado de tokens en reposo, agregar rotación de tokens |

---

### 3.3 Ejecución (AML.TA0005)

#### T-EXEC-001: Inyección Directa de Prompt

| Atributo                | Valor                                                                                     |
| ----------------------- | ----------------------------------------------------------------------------------------- |
| **ID ATLAS**            | AML.T0051.000 - Inyección de Prompt LLM: Directa                                          |
| **Descripción**         | El atacante envía prompts elaborados para manipular el comportamiento del agente           |
| **Vector de Ataque**    | Mensajes de canal que contienen instrucciones adversariales                                |
| **Componentes Afectados** | LLM del agente, todas las superficies de entrada                                        |
| **Mitigaciones Actuales** | Detección de patrones, envoltorio de contenido externo                                  |
| **Riesgo Residual**     | Crítico - Solo detección, sin bloqueo; ataques sofisticados eluden                        |
| **Recomendaciones**     | Implementar defensa multicapa, validación de salida, confirmación del usuario para acciones sensibles |

#### T-EXEC-002: Inyección Indirecta de Prompt

| Atributo                | Valor                                                       |
| ----------------------- | ----------------------------------------------------------- |
| **ID ATLAS**            | AML.T0051.001 - Inyección de Prompt LLM: Indirecta         |
| **Descripción**         | El atacante incrusta instrucciones maliciosas en contenido obtenido |
| **Vector de Ataque**    | URLs maliciosas, emails envenenados, webhooks comprometidos |
| **Componentes Afectados** | web_fetch, ingesta de email, fuentes de datos externas   |
| **Mitigaciones Actuales** | Envoltorio de contenido con etiquetas XML y aviso de seguridad |
| **Riesgo Residual**     | Alto - El LLM puede ignorar las instrucciones del envoltorio |
| **Recomendaciones**     | Implementar sanitización de contenido, contextos de ejecución separados |

#### T-EXEC-003: Inyección de Argumento de Herramienta

| Atributo                | Valor                                                        |
| ----------------------- | ------------------------------------------------------------ |
| **ID ATLAS**            | AML.T0051.000 - Inyección de Prompt LLM: Directa            |
| **Descripción**         | El atacante manipula argumentos de herramienta a través de inyección de prompt |
| **Vector de Ataque**    | Prompts elaborados que influyen en valores de parámetros de herramienta |
| **Componentes Afectados** | Todas las invocaciones de herramientas                     |
| **Mitigaciones Actuales** | Aprobaciones de ejecución para comandos peligrosos         |
| **Riesgo Residual**     | Alto - Depende del juicio del usuario                        |
| **Recomendaciones**     | Implementar validación de argumentos, llamadas de herramientas parametrizadas |

#### T-EXEC-004: Bypass de Aprobación de Exec

| Atributo                | Valor                                                      |
| ----------------------- | ---------------------------------------------------------- |
| **ID ATLAS**            | AML.T0043 - Elaborar Datos Adversariales                   |
| **Descripción**         | El atacante elabora comandos que eluden la lista de permitidos de aprobación |
| **Vector de Ataque**    | Ofuscación de comandos, explotación de alias, manipulación de ruta |
| **Componentes Afectados** | exec-approvals.ts, lista de permitidos de comandos       |
| **Mitigaciones Actuales** | Lista de permitidos + modo ask                           |
| **Riesgo Residual**     | Alto - Sin sanitización de comandos                        |
| **Recomendaciones**     | Implementar normalización de comandos, expandir lista de bloqueados |

---

### 3.4 Persistencia (AML.TA0006)

#### T-PERSIST-001: Instalación de Habilidad Maliciosa

| Atributo                | Valor                                                                    |
| ----------------------- | ------------------------------------------------------------------------ |
| **ID ATLAS**            | AML.T0010.001 - Compromiso de Cadena de Suministro: Software de IA       |
| **Descripción**         | El atacante publica habilidad maliciosa en ClawHub                       |
| **Vector de Ataque**    | Crear cuenta, publicar habilidad con código malicioso oculto             |
| **Componentes Afectados** | ClawHub, carga de habilidades, ejecución de agente                     |
| **Mitigaciones Actuales** | Verificación de antigüedad de cuenta GitHub, indicadores de moderación basados en patrones |
| **Riesgo Residual**     | Crítico - Sin sandboxing, revisión limitada                              |
| **Recomendaciones**     | Integración de VirusTotal (en progreso), sandboxing de habilidades, revisión comunitaria |

#### T-PERSIST-002: Envenenamiento de Actualización de Habilidad

| Atributo                | Valor                                                          |
| ----------------------- | -------------------------------------------------------------- |
| **ID ATLAS**            | AML.T0010.001 - Compromiso de Cadena de Suministro: Software de IA |
| **Descripción**         | El atacante compromete habilidad popular y envía actualización maliciosa |
| **Vector de Ataque**    | Compromiso de cuenta, ingeniería social del propietario de la habilidad |
| **Componentes Afectados** | Versionado de ClawHub, flujos de actualización automática    |
| **Mitigaciones Actuales** | Huella digital de versión                                    |
| **Riesgo Residual**     | Alto - Las actualizaciones automáticas pueden obtener versiones maliciosas |
| **Recomendaciones**     | Implementar firma de actualizaciones, capacidad de reversión, fijación de versión |

#### T-PERSIST-003: Manipulación de Configuración de Agente

| Atributo                | Valor                                                           |
| ----------------------- | --------------------------------------------------------------- |
| **ID ATLAS**            | AML.T0010.002 - Compromiso de Cadena de Suministro: Datos      |
| **Descripción**         | El atacante modifica la configuración del agente para persistir el acceso |
| **Vector de Ataque**    | Modificación de archivo de configuración, inyección de configuración |
| **Componentes Afectados** | Configuración de agente, políticas de herramientas            |
| **Mitigaciones Actuales** | Permisos de archivo                                           |
| **Riesgo Residual**     | Medio - Requiere acceso local                                   |
| **Recomendaciones**     | Verificación de integridad de configuración, registro de auditoría para cambios de configuración |

---

### 3.5 Evasión de Defensa (AML.TA0007)

#### T-EVADE-001: Bypass de Patrón de Moderación

| Atributo                | Valor                                                                  |
| ----------------------- | ---------------------------------------------------------------------- |
| **ID ATLAS**            | AML.T0043 - Elaborar Datos Adversariales                               |
| **Descripción**         | El atacante elabora contenido de habilidad para evadir patrones de moderación |
| **Vector de Ataque**    | Homóglifos Unicode, trucos de codificación, carga dinámica             |
| **Componentes Afectados** | moderation.ts de ClawHub                                             |
| **Mitigaciones Actuales** | FLAG_RULES basados en patrones                                       |
| **Riesgo Residual**     | Alto - Regex simple fácilmente eludido                                 |
| **Recomendaciones**     | Agregar análisis de comportamiento (VirusTotal Code Insight), detección basada en AST |

#### T-EVADE-002: Escape de Envoltorio de Contenido

| Atributo                | Valor                                                     |
| ----------------------- | --------------------------------------------------------- |
| **ID ATLAS**            | AML.T0043 - Elaborar Datos Adversariales                  |
| **Descripción**         | El atacante elabora contenido que escapa del contexto del envoltorio XML |
| **Vector de Ataque**    | Manipulación de etiquetas, confusión de contexto, anulación de instrucciones |
| **Componentes Afectados** | Envoltorio de contenido externo                         |
| **Mitigaciones Actuales** | Etiquetas XML + aviso de seguridad                      |
| **Riesgo Residual**     | Medio - Escapes novedosos descubiertos regularmente       |
| **Recomendaciones**     | Múltiples capas de envoltorio, validación del lado de salida |

---

### 3.6 Descubrimiento (AML.TA0008)

#### T-DISC-001: Enumeración de Herramientas

| Atributo                | Valor                                                 |
| ----------------------- | ----------------------------------------------------- |
| **ID ATLAS**            | AML.T0040 - Acceso a API de Inferencia de Modelo de IA |
| **Descripción**         | El atacante enumera herramientas disponibles mediante prompting |
| **Vector de Ataque**    | Consultas estilo "¿Qué herramientas tienes?"          |
| **Componentes Afectados** | Registro de herramientas del agente                 |
| **Mitigaciones Actuales** | Ninguna específica                                  |
| **Riesgo Residual**     | Bajo - Herramientas generalmente documentadas         |
| **Recomendaciones**     | Considerar controles de visibilidad de herramientas   |

#### T-DISC-002: Extracción de Datos de Sesión

| Atributo                | Valor                                                 |
| ----------------------- | ----------------------------------------------------- |
| **ID ATLAS**            | AML.T0040 - Acceso a API de Inferencia de Modelo de IA |
| **Descripción**         | El atacante extrae datos sensibles del contexto de sesión |
| **Vector de Ataque**    | Consultas "¿Qué discutimos?", sondeo de contexto      |
| **Componentes Afectados** | Transcripciones de sesión, ventana de contexto      |
| **Mitigaciones Actuales** | Aislamiento de sesión por remitente                 |
| **Riesgo Residual**     | Medio - Datos dentro de la sesión accesibles          |
| **Recomendaciones**     | Implementar redacción de datos sensibles en contexto  |

---

### 3.7 Recolección y Exfiltración (AML.TA0009, AML.TA0010)

#### T-EXFIL-001: Robo de Datos vía web_fetch

| Atributo                | Valor                                                                  |
| ----------------------- | ---------------------------------------------------------------------- |
| **ID ATLAS**            | AML.T0009 - Recolección                                                |
| **Descripción**         | El atacante exfiltra datos instruyendo al agente a enviar a URL externa |
| **Vector de Ataque**    | Inyección de prompt causando que el agente haga POST de datos a servidor del atacante |
| **Componentes Afectados** | Herramienta web_fetch                                                |
| **Mitigaciones Actuales** | Bloqueo SSRF para redes internas                                     |
| **Riesgo Residual**     | Alto - URLs externas permitidas                                        |
| **Recomendaciones**     | Implementar lista de permitidos de URL, conciencia de clasificación de datos |

#### T-EXFIL-002: Envío de Mensaje No Autorizado

| Atributo                | Valor                                                            |
| ----------------------- | ---------------------------------------------------------------- |
| **ID ATLAS**            | AML.T0009 - Recolección                                          |
| **Descripción**         | El atacante hace que el agente envíe mensajes que contienen datos sensibles |
| **Vector de Ataque**    | Inyección de prompt causando que el agente envíe mensaje al atacante |
| **Componentes Afectados** | Herramienta de mensaje, integraciones de canales               |
| **Mitigaciones Actuales** | Control de mensajería saliente                                 |
| **Riesgo Residual**     | Medio - El control puede ser eludido                             |
| **Recomendaciones**     | Requerir confirmación explícita para nuevos destinatarios        |

#### T-EXFIL-003: Recolección de Credenciales

| Atributo                | Valor                                                   |
| ----------------------- | ------------------------------------------------------- |
| **ID ATLAS**            | AML.T0009 - Recolección                                 |
| **Descripción**         | La habilidad maliciosa recolecta credenciales del contexto del agente |
| **Vector de Ataque**    | El código de habilidad lee variables de entorno, archivos de configuración |
| **Componentes Afectados** | Entorno de ejecución de habilidades                   |
| **Mitigaciones Actuales** | Ninguna específica para habilidades                   |
| **Riesgo Residual**     | Crítico - Las habilidades se ejecutan con privilegios de agente |
| **Recomendaciones**     | Sandboxing de habilidades, aislamiento de credenciales  |

---

### 3.8 Impacto (AML.TA0011)

#### T-IMPACT-001: Ejecución de Comando No Autorizado

| Atributo                | Valor                                               |
| ----------------------- | --------------------------------------------------- |
| **ID ATLAS**            | AML.T0031 - Erosionar Integridad del Modelo de IA  |
| **Descripción**         | El atacante ejecuta comandos arbitrarios en el sistema del usuario |
| **Vector de Ataque**    | Inyección de prompt combinada con bypass de aprobación de exec |
| **Componentes Afectados** | Herramienta Bash, ejecución de comandos           |
| **Mitigaciones Actuales** | Aprobaciones de exec, opción de sandbox Docker    |
| **Riesgo Residual**     | Crítico - Ejecución en host sin sandbox             |
| **Recomendaciones**     | Por defecto a sandbox, mejorar UX de aprobación     |

#### T-IMPACT-002: Agotamiento de Recursos (DoS)

| Atributo                | Valor                                              |
| ----------------------- | -------------------------------------------------- |
| **ID ATLAS**            | AML.T0031 - Erosionar Integridad del Modelo de IA |
| **Descripción**         | El atacante agota créditos de API o recursos de cómputo |
| **Vector de Ataque**    | Inundación automatizada de mensajes, llamadas de herramientas costosas |
| **Componentes Afectados** | Gateway, sesiones de agente, proveedor de API    |
| **Mitigaciones Actuales** | Ninguna                                          |
| **Riesgo Residual**     | Alto - Sin limitación de tasa                      |
| **Recomendaciones**     | Implementar límites de tasa por remitente, presupuestos de costos |

#### T-IMPACT-003: Daño a la Reputación

| Atributo                | Valor                                                   |
| ----------------------- | ------------------------------------------------------- |
| **ID ATLAS**            | AML.T0031 - Erosionar Integridad del Modelo de IA      |
| **Descripción**         | El atacante hace que el agente envíe contenido dañino/ofensivo |
| **Vector de Ataque**    | Inyección de prompt causando respuestas inapropiadas    |
| **Componentes Afectados** | Generación de salida, mensajería de canal             |
| **Mitigaciones Actuales** | Políticas de contenido del proveedor LLM              |
| **Riesgo Residual**     | Medio - Filtros del proveedor imperfectos               |
| **Recomendaciones**     | Capa de filtrado de salida, controles de usuario       |

---

## 4. Análisis de Cadena de Suministro de ClawHub

### 4.1 Controles de Seguridad Actuales

| Control              | Implementación              | Efectividad                                        |
| -------------------- | --------------------------- | -------------------------------------------------- |
| Antigüedad de Cuenta GitHub | `requireGitHubAccountAge()` | Media - Eleva la barrera para nuevos atacantes  |
| Sanitización de Ruta | `sanitizePath()`            | Alta - Previene recorrido de ruta                  |
| Validación de Tipo de Archivo | `isTextFile()`        | Media - Solo archivos de texto, pero aún pueden ser maliciosos |
| Límites de Tamaño    | 50MB de paquete total       | Alta - Previene agotamiento de recursos            |
| SKILL.md Requerido   | Readme obligatorio          | Bajo valor de seguridad - Solo informativo         |
| Moderación de Patrones | FLAG_RULES en moderation.ts | Baja - Fácilmente eludido                        |
| Estado de Moderación | Campo `moderationStatus`    | Media - Revisión manual posible                    |

### 4.2 Patrones de Indicador de Moderación

Patrones actuales en `moderation.ts`:

```javascript
// Identificadores conocidos como malos
/(keepcold131\/ClawdAuthenticatorTool|ClawdAuthenticatorTool)/i

// Palabras clave sospechosas
/(malware|stealer|phish|phishing|keylogger)/i
/(api[-_ ]?key|token|password|private key|secret)/i
/(wallet|seed phrase|mnemonic|crypto)/i
/(discord\.gg|webhook|hooks\.slack)/i
/(curl[^\n]+\|\s*(sh|bash))/i
/(bit\.ly|tinyurl\.com|t\.co|goo\.gl|is\.gd)/i
```

**Limitaciones:**

- Solo verifica slug, displayName, summary, frontmatter, metadata, rutas de archivo
- No analiza el contenido real del código de habilidad
- Regex simple fácilmente eludido con ofuscación
- Sin análisis de comportamiento

### 4.3 Mejoras Planificadas

| Mejora                 | Estado                                | Impacto                                                               |
| ---------------------- | ------------------------------------- | --------------------------------------------------------------------- |
| Integración de VirusTotal | En Progreso                        | Alto - Análisis de comportamiento de Code Insight                     |
| Reporte Comunitario    | Parcial (existe tabla `skillReports`) | Medio                                                                 |
| Registro de Auditoría  | Parcial (existe tabla `auditLogs`)    | Medio                                                                 |
| Sistema de Insignias   | Implementado                          | Medio - `highlighted`, `official`, `deprecated`, `redactionApproved`  |

---

## 5. Matriz de Riesgo

### 5.1 Probabilidad vs Impacto

| ID de Amenaza | Probabilidad | Impacto  | Nivel de Riesgo | Prioridad |
| ------------- | ------------ | -------- | --------------- | --------- |
| T-EXEC-001    | Alta         | Crítico  | **Crítico**     | P0        |
| T-PERSIST-001 | Alta         | Crítico  | **Crítico**     | P0        |
| T-EXFIL-003   | Media        | Crítico  | **Crítico**     | P0        |
| T-IMPACT-001  | Media        | Crítico  | **Alto**        | P1        |
| T-EXEC-002    | Alta         | Alto     | **Alto**        | P1        |
| T-EXEC-004    | Media        | Alto     | **Alto**        | P1        |
| T-ACCESS-003  | Media        | Alto     | **Alto**        | P1        |
| T-EXFIL-001   | Media        | Alto     | **Alto**        | P1        |
| T-IMPACT-002  | Alta         | Medio    | **Alto**        | P1        |
| T-EVADE-001   | Alta         | Medio    | **Medio**       | P2        |
| T-ACCESS-001  | Baja         | Alto     | **Medio**       | P2        |
| T-ACCESS-002  | Baja         | Alto     | **Medio**       | P2        |
| T-PERSIST-002 | Baja         | Alto     | **Medio**       | P2        |

### 5.2 Cadenas de Ataque de Ruta Crítica

**Cadena de Ataque 1: Robo de Datos Basado en Habilidad**

```
T-PERSIST-001 → T-EVADE-001 → T-EXFIL-003
(Publicar habilidad maliciosa) → (Evadir moderación) → (Recolectar credenciales)
```

**Cadena de Ataque 2: Inyección de Prompt a RCE**

```
T-EXEC-001 → T-EXEC-004 → T-IMPACT-001
(Inyectar prompt) → (Eludir aprobación de exec) → (Ejecutar comandos)
```

**Cadena de Ataque 3: Inyección Indirecta vía Contenido Obtenido**

```
T-EXEC-002 → T-EXFIL-001 → Exfiltración externa
(Envenenar contenido de URL) → (Agente obtiene y sigue instrucciones) → (Datos enviados al atacante)
```

---

## 6. Resumen de Recomendaciones

### 6.1 Inmediato (P0)

| ID    | Recomendación                              | Aborda                     |
| ----- | ------------------------------------------ | -------------------------- |
| R-001 | Completar integración de VirusTotal        | T-PERSIST-001, T-EVADE-001 |
| R-002 | Implementar sandboxing de habilidades      | T-PERSIST-001, T-EXFIL-003 |
| R-003 | Agregar validación de salida para acciones sensibles | T-EXEC-001, T-EXEC-002 |

### 6.2 Corto plazo (P1)

| ID    | Recomendación                           | Aborda       |
| ----- | --------------------------------------- | ------------ |
| R-004 | Implementar limitación de tasa          | T-IMPACT-002 |
| R-005 | Agregar cifrado de tokens en reposo     | T-ACCESS-003 |
| R-006 | Mejorar UX y validación de aprobación de exec | T-EXEC-004 |
| R-007 | Implementar lista de permitidos de URL para web_fetch | T-EXFIL-001 |

### 6.3 Mediano plazo (P2)

| ID    | Recomendación                                        | Aborda        |
| ----- | ---------------------------------------------------- | ------------- |
| R-008 | Agregar verificación criptográfica de canal donde sea posible | T-ACCESS-002 |
| R-009 | Implementar verificación de integridad de configuración | T-PERSIST-003 |
| R-010 | Agregar firma de actualizaciones y fijación de versión | T-PERSIST-002 |

---

## 7. Apéndices

### 7.1 Mapeo de Técnicas ATLAS

| ID ATLAS      | Nombre de Técnica              | Amenazas de OpenClaw                                             |
| ------------- | ------------------------------ | ---------------------------------------------------------------- |
| AML.T0006     | Escaneo Activo                 | T-RECON-001, T-RECON-002                                         |
| AML.T0009     | Recolección                    | T-EXFIL-001, T-EXFIL-002, T-EXFIL-003                            |
| AML.T0010.001 | Cadena de Suministro: Software de IA | T-PERSIST-001, T-PERSIST-002                               |
| AML.T0010.002 | Cadena de Suministro: Datos    | T-PERSIST-003                                                    |
| AML.T0031     | Erosionar Integridad del Modelo de IA | T-IMPACT-001, T-IMPACT-002, T-IMPACT-003                   |
| AML.T0040     | Acceso a API de Inferencia de Modelo de IA | T-ACCESS-001, T-ACCESS-002, T-ACCESS-003, T-DISC-001, T-DISC-002 |
| AML.T0043     | Elaborar Datos Adversariales   | T-EXEC-004, T-EVADE-001, T-EVADE-002                             |
| AML.T0051.000 | Inyección de Prompt LLM: Directa | T-EXEC-001, T-EXEC-003                                         |
| AML.T0051.001 | Inyección de Prompt LLM: Indirecta | T-EXEC-002                                                   |

### 7.2 Archivos Clave de Seguridad

| Ruta                                | Propósito                       | Nivel de Riesgo |
| ----------------------------------- | ------------------------------- | --------------- |
| `src/infra/exec-approvals.ts`      | Lógica de aprobación de comandos | **Crítico**    |
| `src/gateway/auth.ts`               | Autenticación de gateway         | **Crítico**    |
| `src/web/inbound/access-control.ts` | Control de acceso al canal       | **Crítico**    |
| `src/infra/net/ssrf.ts`             | Protección SSRF                  | **Crítico**    |
| `src/security/external-content.ts`  | Mitigación de inyección de prompt | **Crítico**   |
| `src/agents/sandbox/tool-policy.ts` | Aplicación de política de herramientas | **Crítico** |
| `convex/lib/moderation.ts`          | Moderación de ClawHub            | **Alto**       |
| `convex/lib/skillPublish.ts`        | Flujo de publicación de habilidades | **Alto**    |
| `src/routing/resolve-route.ts`      | Aislamiento de sesión            | **Medio**      |

### 7.3 Glosario

| Término              | Definición                                                |
| -------------------- | --------------------------------------------------------- |
| **ATLAS**            | Adversarial Threat Landscape for AI Systems de MITRE      |
| **ClawHub**          | Mercado de habilidades de OpenClaw                        |
| **Gateway**          | Capa de enrutamiento de mensajes y autenticación de OpenClaw |
| **MCP**              | Model Context Protocol - interfaz de proveedor de herramientas |
| **Inyección de Prompt** | Ataque donde instrucciones maliciosas se incrustan en la entrada |
| **Habilidad**        | Extensión descargable para agentes OpenClaw               |
| **SSRF**             | Server-Side Request Forgery                               |

---

_Este modelo de amenazas es un documento vivo. Reporta problemas de seguridad a security@openclaw.ai_
