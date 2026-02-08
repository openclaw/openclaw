import { Type } from "@sinclair/typebox";
import { stringEnum } from "openclaw/plugin-sdk";

const DEFAULT_BASE_URL = "http://localhost:8000";

type FcmNotificationType = "ping" | "text" | "link" | "app" | "raw";
type FcmPriority = "normal" | "high";

interface FcmSendRequest {
  to: string;
  type: FcmNotificationType;
  title?: string;
  message?: string;
  clipboard?: boolean;
  url?: string;
  package?: string;
  raw_data?: Record<string, unknown>;
  topic?: boolean;
  ttl?: number;
  priority?: FcmPriority;
}

interface FcmSendResponse {
  success: boolean;
  messageId?: string;
  error?: string;
}

async function sendFcmNotification(
  baseUrl: string,
  payload: FcmSendRequest,
): Promise<FcmSendResponse> {
  const url = `${baseUrl}/send`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => response.statusText);
    throw new Error(`FCM Gateway error (${response.status}): ${errorText}`);
  }

  const data = (await response.json()) as FcmSendResponse;
  return data;
}

const fcmGatewayPlugin = {
  id: "fcm-gateway",
  name: "FCM Gateway",
  description: "Plugin per inviare notifiche FCM tramite gateway locale",
  register(api) {
    const baseUrl = (api.pluginConfig?.baseUrl as string | undefined) || DEFAULT_BASE_URL;

    // Tool per inviare notifiche ping
    api.registerTool(
      {
        name: "fcm_send_ping",
        description:
          "Invia una notifica ping FCM a un dispositivo o topic. Utile per testare la connessione.",
        parameters: Type.Object({
          deviceToken: Type.String({
            description:
              "FCM token del dispositivo (es: 'dK3j...xyz') o nome del topic se topic=true",
          }),
          topic: Type.Optional(
            Type.Boolean({
              description: "Se true, deviceToken è interpretato come nome di un topic",
              default: false,
            }),
          ),
          priority: Type.Optional(
            stringEnum(["normal", "high"], {
              description: "Priorità della notifica",
              default: "high",
            }),
          ),
          ttl: Type.Optional(
            Type.Integer({
              description: "TTL in secondi (default: 86400)",
              minimum: 0,
            }),
          ),
        }),
        async execute(_id, params) {
          const payload: FcmSendRequest = {
            to: params.deviceToken,
            type: "ping",
            topic: params.topic ?? false,
            priority: (params.priority as FcmPriority | undefined) ?? "high",
          };
          if (params.ttl !== undefined) {
            payload.ttl = params.ttl;
          }

          try {
            const result = await sendFcmNotification(baseUrl, payload);
            return {
              content: [
                {
                  type: "text",
                  text: `Notifica ping inviata con successo${result.messageId ? ` (ID: ${result.messageId})` : ""}`,
                },
              ],
            };
          } catch (error) {
            return {
              content: [
                {
                  type: "text",
                  text: `Errore nell'invio della notifica ping: ${error instanceof Error ? error.message : String(error)}`,
                },
              ],
            };
          }
        },
      },
      { optional: true },
    );

    // Tool per inviare notifiche di testo
    api.registerTool(
      {
        name: "fcm_send_text",
        description: "Invia una notifica di testo FCM con titolo e messaggio opzionale.",
        parameters: Type.Object({
          deviceToken: Type.String({
            description:
              "FCM token del dispositivo (es: 'dK3j...xyz') o nome del topic se topic=true",
          }),
          title: Type.String({
            description: "Titolo della notifica",
          }),
          message: Type.Optional(
            Type.String({
              description: "Corpo del messaggio",
            }),
          ),
          clipboard: Type.Optional(
            Type.Boolean({
              description: "Copia il messaggio negli appunti del dispositivo",
              default: false,
            }),
          ),
          topic: Type.Optional(
            Type.Boolean({
              description: "Se true, deviceToken è interpretato come nome di un topic",
              default: false,
            }),
          ),
          priority: Type.Optional(
            stringEnum(["normal", "high"], {
              description: "Priorità della notifica",
              default: "high",
            }),
          ),
          ttl: Type.Optional(
            Type.Integer({
              description: "TTL in secondi (default: 86400)",
              minimum: 0,
            }),
          ),
        }),
        async execute(_id, params) {
          const payload: FcmSendRequest = {
            to: params.deviceToken,
            type: "text",
            title: params.title,
            topic: params.topic ?? false,
            priority: (params.priority as FcmPriority | undefined) ?? "high",
          };
          if (params.message) {
            payload.message = params.message;
          }
          if (params.clipboard !== undefined) {
            payload.clipboard = params.clipboard;
          }
          if (params.ttl !== undefined) {
            payload.ttl = params.ttl;
          }

          try {
            const result = await sendFcmNotification(baseUrl, payload);
            return {
              content: [
                {
                  type: "text",
                  text: `Notifica di testo inviata con successo${result.messageId ? ` (ID: ${result.messageId})` : ""}`,
                },
              ],
            };
          } catch (error) {
            return {
              content: [
                {
                  type: "text",
                  text: `Errore nell'invio della notifica di testo: ${error instanceof Error ? error.message : String(error)}`,
                },
              ],
            };
          }
        },
      },
      { optional: true },
    );

    // Tool per inviare notifiche con link
    api.registerTool(
      {
        name: "fcm_send_link",
        description: "Invia una notifica FCM con un link da aprire.",
        parameters: Type.Object({
          deviceToken: Type.String({
            description:
              "FCM token del dispositivo (es: 'dK3j...xyz') o nome del topic se topic=true",
          }),
          title: Type.String({
            description: "Titolo della notifica",
          }),
          url: Type.String({
            description: "URL da aprire",
          }),
          topic: Type.Optional(
            Type.Boolean({
              description: "Se true, deviceToken è interpretato come nome di un topic",
              default: false,
            }),
          ),
          priority: Type.Optional(
            stringEnum(["normal", "high"], {
              description: "Priorità della notifica",
              default: "high",
            }),
          ),
          ttl: Type.Optional(
            Type.Integer({
              description: "TTL in secondi (default: 86400)",
              minimum: 0,
            }),
          ),
        }),
        async execute(_id, params) {
          const payload: FcmSendRequest = {
            to: params.deviceToken,
            type: "link",
            title: params.title,
            url: params.url,
            topic: params.topic ?? false,
            priority: (params.priority as FcmPriority | undefined) ?? "high",
          };
          if (params.ttl !== undefined) {
            payload.ttl = params.ttl;
          }

          try {
            const result = await sendFcmNotification(baseUrl, payload);
            return {
              content: [
                {
                  type: "text",
                  text: `Notifica con link inviata con successo${result.messageId ? ` (ID: ${result.messageId})` : ""}`,
                },
              ],
            };
          } catch (error) {
            return {
              content: [
                {
                  type: "text",
                  text: `Errore nell'invio della notifica con link: ${error instanceof Error ? error.message : String(error)}`,
                },
              ],
            };
          }
        },
      },
      { optional: true },
    );

    // Tool per inviare notifiche app
    api.registerTool(
      {
        name: "fcm_send_app",
        description: "Invia una notifica FCM per aprire un'applicazione.",
        parameters: Type.Object({
          deviceToken: Type.String({
            description:
              "FCM token del dispositivo (es: 'dK3j...xyz') o nome del topic se topic=true",
          }),
          title: Type.String({
            description: "Titolo della notifica",
          }),
          package: Type.String({
            description: "Package name dell'applicazione da aprire",
          }),
          topic: Type.Optional(
            Type.Boolean({
              description: "Se true, deviceToken è interpretato come nome di un topic",
              default: false,
            }),
          ),
          priority: Type.Optional(
            stringEnum(["normal", "high"], {
              description: "Priorità della notifica",
              default: "high",
            }),
          ),
          ttl: Type.Optional(
            Type.Integer({
              description: "TTL in secondi (default: 86400)",
              minimum: 0,
            }),
          ),
        }),
        async execute(_id, params) {
          const payload: FcmSendRequest = {
            to: params.deviceToken,
            type: "app",
            title: params.title,
            package: params.package,
            topic: params.topic ?? false,
            priority: (params.priority as FcmPriority | undefined) ?? "high",
          };
          if (params.ttl !== undefined) {
            payload.ttl = params.ttl;
          }

          try {
            const result = await sendFcmNotification(baseUrl, payload);
            return {
              content: [
                {
                  type: "text",
                  text: `Notifica app inviata con successo${result.messageId ? ` (ID: ${result.messageId})` : ""}`,
                },
              ],
            };
          } catch (error) {
            return {
              content: [
                {
                  type: "text",
                  text: `Errore nell'invio della notifica app: ${error instanceof Error ? error.message : String(error)}`,
                },
              ],
            };
          }
        },
      },
      { optional: true },
    );

    // Tool per inviare notifiche raw
    api.registerTool(
      {
        name: "fcm_send_raw",
        description: "Invia una notifica FCM con payload personalizzato (raw_data).",
        parameters: Type.Object({
          deviceToken: Type.String({
            description:
              "FCM token del dispositivo (es: 'dK3j...xyz') o nome del topic se topic=true",
          }),
          raw_data: Type.Record(Type.String(), Type.Any(), {
            description: "Payload personalizzato da inviare",
          }),
          topic: Type.Optional(
            Type.Boolean({
              description: "Se true, deviceToken è interpretato come nome di un topic",
              default: false,
            }),
          ),
          priority: Type.Optional(
            stringEnum(["normal", "high"], {
              description: "Priorità della notifica",
              default: "high",
            }),
          ),
          ttl: Type.Optional(
            Type.Integer({
              description: "TTL in secondi (default: 86400)",
              minimum: 0,
            }),
          ),
        }),
        async execute(_id, params) {
          const payload: FcmSendRequest = {
            to: params.deviceToken,
            type: "raw",
            raw_data: params.raw_data as Record<string, unknown>,
            topic: params.topic ?? false,
            priority: (params.priority as FcmPriority | undefined) ?? "high",
          };
          if (params.ttl !== undefined) {
            payload.ttl = params.ttl;
          }

          try {
            const result = await sendFcmNotification(baseUrl, payload);
            return {
              content: [
                {
                  type: "text",
                  text: `Notifica raw inviata con successo${result.messageId ? ` (ID: ${result.messageId})` : ""}`,
                },
              ],
            };
          } catch (error) {
            return {
              content: [
                {
                  type: "text",
                  text: `Errore nell'invio della notifica raw: ${error instanceof Error ? error.message : String(error)}`,
                },
              ],
            };
          }
        },
      },
      { optional: true },
    );

    api.logger.info(`[fcm-gateway] Plugin registrato con baseUrl: ${baseUrl}`);
  },
};

export default fcmGatewayPlugin;
