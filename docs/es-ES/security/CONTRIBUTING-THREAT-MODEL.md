# Contribuir al Modelo de Amenazas de OpenClaw

Gracias por ayudar a hacer OpenClaw más seguro. Este modelo de amenazas es un documento vivo y recibimos contribuciones de cualquier persona - no necesitas ser un experto en seguridad.

## Formas de Contribuir

### Agregar una Amenaza

¿Detectaste un vector de ataque o riesgo que no hemos cubierto? Abre un issue en [openclaw/trust](https://github.com/openclaw/trust/issues) y descríbelo con tus propias palabras. No necesitas conocer ningún framework ni llenar todos los campos - solo describe el escenario.

**Útil incluir (pero no requerido):**

- El escenario de ataque y cómo podría ser explotado
- Qué partes de OpenClaw se ven afectadas (CLI, gateway, canales, ClawHub, servidores MCP, etc.)
- Qué tan severo crees que es (bajo / medio / alto / crítico)
- Cualquier enlace a investigación relacionada, CVEs o ejemplos del mundo real

Nos encargaremos del mapeo de ATLAS, IDs de amenazas y evaluación de riesgos durante la revisión. Si quieres incluir esos detalles, genial - pero no se espera.

> **Esto es para agregar al modelo de amenazas, no para reportar vulnerabilidades en vivo.** Si has encontrado una vulnerabilidad explotable, consulta nuestra [página de Confianza](https://trust.openclaw.ai) para obtener instrucciones de divulgación responsable.

### Sugerir una Mitigación

¿Tienes una idea de cómo abordar una amenaza existente? Abre un issue o PR haciendo referencia a la amenaza. Las mitigaciones útiles son específicas y accionables - por ejemplo, "limitación de tasa por remitente de 10 mensajes/minuto en el gateway" es mejor que "implementar limitación de tasa".

### Proponer una Cadena de Ataque

Las cadenas de ataque muestran cómo múltiples amenazas se combinan en un escenario de ataque realista. Si ves una combinación peligrosa, describe los pasos y cómo un atacante los encadenaría. Una narrativa corta de cómo se desarrolla el ataque en la práctica es más valiosa que una plantilla formal.

### Corregir o Mejorar Contenido Existente

Errores tipográficos, aclaraciones, información desactualizada, mejores ejemplos - los PRs son bienvenidos, no se necesita issue.

## Lo Que Usamos

### MITRE ATLAS

Este modelo de amenazas está construido sobre [MITRE ATLAS](https://atlas.mitre.org/) (Adversarial Threat Landscape for AI Systems), un framework diseñado específicamente para amenazas de IA/ML como inyección de prompts, mal uso de herramientas y explotación de agentes. No necesitas conocer ATLAS para contribuir - mapeamos las contribuciones al framework durante la revisión.

### IDs de Amenazas

Cada amenaza obtiene un ID como `T-EXEC-003`. Las categorías son:

| Código  | Categoría                                    |
| ------- | -------------------------------------------- |
| RECON   | Reconocimiento - recopilación de información |
| ACCESS  | Acceso inicial - obtener entrada             |
| EXEC    | Ejecución - ejecutar acciones maliciosas     |
| PERSIST | Persistencia - mantener acceso               |
| EVADE   | Evasión de defensa - evitar detección        |
| DISC    | Descubrimiento - aprender sobre el entorno   |
| EXFIL   | Exfiltración - robar datos                   |
| IMPACT  | Impacto - daño o interrupción                |

Los IDs son asignados por los mantenedores durante la revisión. No necesitas elegir uno.

### Niveles de Riesgo

| Nivel       | Significado                                                         |
| ----------- | ------------------------------------------------------------------- |
| **Crítico** | Compromiso total del sistema, o alta probabilidad + impacto crítico |
| **Alto**    | Daño significativo probable, o probabilidad media + impacto crítico |
| **Medio**   | Riesgo moderado, o baja probabilidad + alto impacto                 |
| **Bajo**    | Improbable e impacto limitado                                       |

Si no estás seguro del nivel de riesgo, simplemente describe el impacto y lo evaluaremos.

## Proceso de Revisión

1. **Triaje** - Revisamos nuevas contribuciones dentro de las 48 horas
2. **Evaluación** - Verificamos la viabilidad, asignamos mapeo de ATLAS e ID de amenaza, validamos el nivel de riesgo
3. **Documentación** - Nos aseguramos de que todo esté formateado y completo
4. **Fusión** - Agregado al modelo de amenazas y visualización

## Recursos

- [Sitio web de ATLAS](https://atlas.mitre.org/)
- [Técnicas de ATLAS](https://atlas.mitre.org/techniques/)
- [Estudios de caso de ATLAS](https://atlas.mitre.org/studies/)
- [Modelo de Amenazas de OpenClaw](./THREAT-MODEL-ATLAS.md)

## Contacto

- **Vulnerabilidades de seguridad:** Consulta nuestra [página de Confianza](https://trust.openclaw.ai) para obtener instrucciones de reporte
- **Preguntas sobre el modelo de amenazas:** Abre un issue en [openclaw/trust](https://github.com/openclaw/trust/issues)
- **Chat general:** Discord canal #security

## Reconocimiento

Los contribuyentes al modelo de amenazas son reconocidos en los agradecimientos del modelo de amenazas, notas de lanzamiento y el salón de la fama de seguridad de OpenClaw por contribuciones significativas.
