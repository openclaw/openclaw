# Plugin FCM Gateway

Plugin OpenClaw per inviare notifiche FCM (Firebase Cloud Messaging) tramite un gateway locale.

## 🚀 Quick Start

1. **Abilita il plugin** in `~/.openclaw/openclaw.json`:

   ```json5
   {
     plugins: {
       entries: {
         "fcm-gateway": { enabled: true },
       },
     },
   }
   ```

2. **Configura i tool** in `~/.openclaw/tools.json5`:

   ```json5
   {
     list: [
       {
         id: "main",
         tools: { allow: ["fcm-gateway"] },
       },
     ],
   }
   ```

3. **Includi il file** in `openclaw.json`:

   ```json5
   {
     agents: {
       defaults: { ... },
       "$include": "./tools.json5"
     }
   }
   ```

4. **Riavvia il gateway**: `openclaw gateway restart`

5. **Usa i tool**: L'agente può ora inviare notifiche FCM!

## 📋 Panoramica

Questo plugin permette agli agenti OpenClaw di inviare notifiche push ai dispositivi Android/iOS tramite un servizio FCM Gateway locale. Il gateway è un servizio HTTP in Python che gira in Docker e gestisce l'invio delle notifiche FCM.

## 🏗️ Architettura

```
┌─────────────┐         ┌──────────────┐         ┌─────────────┐
│   OpenClaw  │  HTTP   │ FCM Gateway  │   FCM   │  Dispositivo │
│   Agent     │ ──────> │  (Docker)    │ ──────> │   Android/   │
│             │         │ localhost:   │         │     iOS      │
│             │         │    8000      │         │              │
└─────────────┘         └──────────────┘         └─────────────┘
```

## 📁 Struttura del Plugin

Il plugin è composto da due file principali:

### 1. `openclaw.plugin.json` - Manifest del Plugin

Il manifest definisce l'identità del plugin e lo schema di configurazione:

```json
{
  "id": "fcm-gateway",
  "configSchema": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "baseUrl": {
        "type": "string",
        "default": "http://localhost:8000",
        "description": "Base URL del FCM Gateway locale"
      }
    }
  }
}
```

**Campi:**

- `id`: Identificatore univoco del plugin
- `configSchema`: Schema JSON per validare la configurazione del plugin

### 2. `index.ts` - Implementazione del Plugin

Il file principale contiene:

- La logica per inviare notifiche FCM
- La registrazione di 5 tool opzionali per l'agente LLM
- La gestione degli errori e delle risposte

## 🛠️ Tool Disponibili

Il plugin registra 5 tool opzionali (devono essere esplicitamente abilitati nell'allowlist):

### 1. `fcm_send_ping`

Invia una notifica ping per testare la connessione.

**Parametri:**

- `deviceToken` (string, obbligatorio): FCM token del dispositivo o nome del topic
- `topic` (boolean, opzionale): Se `true`, `deviceToken` è interpretato come nome di un topic
- `priority` (string, opzionale): `"normal"` o `"high"` (default: `"high"`)
- `ttl` (integer, opzionale): TTL in secondi (default: 86400)

### 2. `fcm_send_text`

Invia una notifica di testo con titolo e messaggio.

**Parametri:**

- `deviceToken` (string, obbligatorio): FCM token del dispositivo
- `title` (string, obbligatorio): Titolo della notifica
- `message` (string, opzionale): Corpo del messaggio
- `clipboard` (boolean, opzionale): Copia il messaggio negli appunti del dispositivo
- `topic`, `priority`, `ttl`: Come sopra

### 3. `fcm_send_link`

Invia una notifica con un link da aprire.

**Parametri:**

- `deviceToken` (string, obbligatorio): FCM token del dispositivo
- `title` (string, obbligatorio): Titolo della notifica
- `url` (string, obbligatorio): URL da aprire
- `topic`, `priority`, `ttl`: Come sopra

### 4. `fcm_send_app`

Invia una notifica per aprire un'applicazione.

**Parametri:**

- `deviceToken` (string, obbligatorio): FCM token del dispositivo
- `title` (string, obbligatorio): Titolo della notifica
- `package` (string, obbligatorio): Package name dell'applicazione da aprire
- `topic`, `priority`, `ttl`: Come sopra

### 5. `fcm_send_raw`

Invia una notifica con payload personalizzato.

**Parametri:**

- `deviceToken` (string, obbligatorio): FCM token del dispositivo
- `raw_data` (object, obbligatorio): Payload personalizzato da inviare
- `topic`, `priority`, `ttl`: Come sopra

## ⚙️ Configurazione

### Passo 1: Abilitare il Plugin

Aggiungi il plugin alla configurazione in `~/.openclaw/openclaw.json`:

```json5
{
  plugins: {
    enabled: true,
    entries: {
      "fcm-gateway": {
        enabled: true,
        config: {
          baseUrl: "http://localhost:8000", // Opzionale, default è questo
        },
      },
    },
  },
}
```

### Passo 2: Configurare i Tool

I tool del plugin sono **opzionali** e devono essere esplicitamente abilitati nell'allowlist dell'agente.

#### Opzione A: Configurazione nel file principale

Aggiungi la configurazione dei tool direttamente in `openclaw.json`:

```json5
{
  agents: {
    defaults: {
      // ... altre configurazioni
    },
    list: [
      {
        id: "main",
        tools: {
          allow: [
            "fcm-gateway", // Abilita tutti i tool del plugin
            // Oppure abilita tool specifici:
            // "fcm_send_ping",
            // "fcm_send_text",
            // "fcm_send_link",
            // "fcm_send_app",
            // "fcm_send_raw"
          ],
        },
      },
    ],
  },
}
```

#### Opzione B: Configurazione separata (consigliata)

Crea un file separato `~/.openclaw/tools.json5`:

```json5
{
  // Configurazione tools per gli agenti
  list: [
    {
      id: "main",
      tools: {
        allow: [
          "fcm-gateway", // Abilita tutti i tool del plugin
        ],
      },
    },
  ],
}
```

Poi includilo in `openclaw.json`:

```json5
{
  agents: {
    defaults: {
      // ... configurazioni defaults
    },
    $include: "./tools.json5",
  },
}
```

**Vantaggi della configurazione separata:**

- ✅ Organizzazione migliore
- ✅ File principale più pulito
- ✅ Facile da mantenere

### Passo 3: Riavviare il Gateway

Dopo aver modificato la configurazione, riavvia il gateway:

```bash
openclaw gateway restart
```

Oppure se usi un servizio:

```bash
systemctl --user restart openclaw-gateway
```

## 🧪 Verifica della Configurazione

### Verificare che il plugin sia caricato

```bash
openclaw plugins list
```

Dovresti vedere `fcm-gateway` nella lista.

### Verificare i dettagli del plugin

```bash
openclaw plugins info fcm-gateway
```

### Verificare la configurazione

```bash
openclaw doctor
```

Dovrebbe mostrare il plugin caricato correttamente.

## 📝 Esempi di Utilizzo

### Esempio 1: Inviare una notifica di testo

L'agente può chiamare il tool direttamente:

```json
{
  "tool": "fcm_send_text",
  "args": {
    "deviceToken": "dK3jH8xYz9...",
    "title": "Notifica importante",
    "message": "Hai ricevuto un nuovo messaggio!",
    "priority": "high"
  }
}
```

### Esempio 2: Inviare una notifica con link

```json
{
  "tool": "fcm_send_link",
  "args": {
    "deviceToken": "dK3jH8xYz9...",
    "title": "Apri questo link",
    "url": "https://example.com",
    "priority": "high"
  }
}
```

### Esempio 3: Inviare a un topic

```json
{
  "tool": "fcm_send_text",
  "args": {
    "deviceToken": "news-updates",
    "topic": true,
    "title": "Aggiornamento",
    "message": "Nuovo aggiornamento disponibile!"
  }
}
```

## 🔧 Sviluppo del Plugin

### Struttura del Codice

Il plugin segue il pattern standard di OpenClaw:

1. **Registrazione del plugin**: Il plugin esporta un oggetto con `id`, `name`, `description` e `register`
2. **Registrazione dei tool**: Ogni tool viene registrato con `api.registerTool()`
3. **Tool opzionali**: Tutti i tool sono marcati come `optional: true` per sicurezza

### Pattern di Registrazione Tool

```typescript
api.registerTool(
  {
    name: "tool_name",
    description: "Descrizione del tool",
    parameters: Type.Object({
      // Schema dei parametri
    }),
    async execute(_id, params) {
      // Logica del tool
    },
  },
  { optional: true }, // Tool opzionale (richiede allowlist)
);
```

### Gestione degli Errori

Il plugin gestisce gli errori HTTP e restituisce messaggi chiari:

```typescript
try {
  const result = await sendFcmNotification(baseUrl, payload);
  return {
    content: [
      {
        type: "text",
        text: `Notifica inviata con successo${result.messageId ? ` (ID: ${result.messageId})` : ""}`,
      },
    ],
  };
} catch (error) {
  return {
    content: [
      {
        type: "text",
        text: `Errore: ${error instanceof Error ? error.message : String(error)}`,
      },
    ],
  };
}
```

## 🚀 Prerequisiti

### FCM Gateway Locale

Prima di usare il plugin, devi avere un FCM Gateway locale in esecuzione:

1. **Setup Docker**: Assicurati di avere Docker e Docker Compose installati
2. **Credenziali Firebase**: Scarica `serviceAccountKey.json` da Firebase Console
   - Vai su Firebase Console → Project Settings → Service accounts
   - Clicca "Generate new private key"
   - Salva il file come `credentials/serviceAccountKey.json`
3. **Avvia il gateway**:
   ```bash
   docker compose up -d
   ```
4. **Verifica**:
   ```bash
   curl http://localhost:8000/health
   # Dovrebbe restituire: {"status":"ok","credentials":true}
   ```

Vedi la documentazione del FCM Gateway per i dettagli completi.

### Ottenere il Device Token FCM

Per inviare notifiche a un dispositivo, hai bisogno del suo FCM token:

1. **Android**: Il token viene generato dall'app quando si registra per le notifiche push
2. **iOS**: Simile ad Android, il token viene fornito dall'app
3. **App FCM Toolbox**: Se usi l'app FCM Toolbox, il token viene mostrato nell'interfaccia dell'app

**Nota**: Il token può cambiare quando:

- L'app viene reinstallata
- L'app viene aggiornata
- Il dispositivo viene formattato
- L'utente disinstalla e reinstalla l'app

Assicurati di aggiornare il token quando necessario.

## 🔍 Troubleshooting

### Il plugin non viene caricato

1. Verifica che il plugin sia abilitato in `plugins.entries.fcm-gateway.enabled`
2. Controlla i log: `openclaw logs`
3. Esegui `openclaw doctor` per diagnosticare problemi

### I tool non sono disponibili

1. Verifica che i tool siano nell'allowlist: `agents.list[].tools.allow`
2. Controlla che il plugin sia caricato: `openclaw plugins list`
3. Riavvia il gateway dopo le modifiche alla configurazione

### Errori di connessione al gateway

1. Verifica che il FCM Gateway sia in esecuzione: `curl http://localhost:8000/health`
2. Controlla l'URL base nella configurazione del plugin
3. Verifica che il gateway sia raggiungibile dalla macchina OpenClaw

### Notifiche non arrivano

1. Verifica che il `deviceToken` sia corretto
2. Controlla i log del FCM Gateway
3. Verifica le credenziali Firebase nel gateway

## 📚 Riferimenti

- [Documentazione Plugin OpenClaw](/plugin)
- [Plugin Agent Tools](/plugins/agent-tools)
- [Configurazione Gateway](/gateway/configuration)
- [FCM Gateway Documentation](https://github.com/your-repo/fcm-gateway)

## 📄 Licenza

Questo plugin è parte del progetto OpenClaw.

## 🤝 Contribuire

Per contribuire al plugin:

1. Modifica il codice in `extensions/fcm-gateway/`
2. Testa le modifiche: `pnpm build && pnpm test`
3. Verifica la configurazione: `openclaw doctor`
4. Invia una pull request

## 📝 Changelog

### v1.0.0 (2026-02-05)

- ✨ Release iniziale
- ✅ 5 tool per inviare notifiche FCM
- ✅ Supporto per ping, text, link, app e raw notifications
- ✅ Configurazione separata dei tools
- ✅ Gestione errori completa
