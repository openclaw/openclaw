import { resolveMessageLocale } from "../../shared/message-locale.js";

const english = {
  CONTEXT_OVERFLOW_ERROR_USER_MESSAGE:
    "⚠️ Context overflow — prompt too large for this model. Try a shorter message or a larger-context model.",
  RATE_LIMIT_ERROR_USER_MESSAGE:
    "⚠️ The AI service needs a short break. Please try again in a few minutes.",
  AUTH_INVALID_TOKEN_USER_TEXT:
    "Couldn't sign in to the AI service. Sign in again under Models in the OpenClaw app or run `openclaw configure`.",
  TLS_CERTIFICATE_ERROR_USER_TEXT:
    "Couldn't connect securely to the AI service. For details, open Settings → Logs in the OpenClaw app or run `openclaw logs --follow`.",
  OAUTH_REFRESH_CONTENTION_USER_TEXT:
    "Another sign-in is still in progress. Wait a moment, then try again.",
  SELECTED_AUTH_PROFILE_UNAVAILABLE_USER_TEXT:
    "This saved login isn't available. Choose another login under Models in the OpenClaw app or run `openclaw configure`.",
  MODEL_CAPACITY_ERROR_USER_MESSAGE:
    "⚠️ Selected model is at capacity. Try a different model, or wait and retry.",
  OVERLOADED_ERROR_USER_MESSAGE:
    "The AI service is temporarily overloaded. Please try again in a moment.",
  PROVIDER_PROMPT_SIZE_LIMIT_USER_MESSAGE:
    "⚠️ The provider rejected this request because the prompt exceeds its per-request limit. Shorten the prompt and try again, or choose a model with a larger limit.",
  GENERIC_EXTERNAL_RUN_FAILURE_TEXT:
    "⚠️ OpenClaw couldn't finish this request. Check the conversation before trying again. For details, open Settings → Logs in the OpenClaw app or run `openclaw logs --follow`.",
  PROVIDER_CONVERSATION_STATE_ERROR_USER_MESSAGE:
    "⚠️ The model provider rejected the conversation state. Please try again, or use /new to start a fresh session.",
  PROVIDER_RATE_LIMIT_OR_QUOTA_ERROR_USER_MESSAGE:
    "⚠️ The AI service can't accept more requests right now. Wait a few minutes, then try again. If it continues, check your account's usage and billing limits.",
  PROVIDER_INTERNAL_ERROR_USER_MESSAGE:
    "⚠️ The model provider returned a temporary internal error before replying. Try again in a moment, or switch to another model if it keeps happening.",
  PROVIDER_MODEL_UNAVAILABLE_USER_MESSAGE:
    "⚠️ This model was not found. Choose another model in the OpenClaw app or run `openclaw configure`.",
} as const;

type MessageKey = keyof typeof english;
const german: Record<MessageKey, string> = {
  CONTEXT_OVERFLOW_ERROR_USER_MESSAGE:
    "⚠️ Das Kontextfenster dieses Modells ist für die Anfrage zu klein. Kürze die Nachricht oder wähle ein Modell mit einem größeren Kontextfenster.",
  RATE_LIMIT_ERROR_USER_MESSAGE:
    "⚠️ Der KI-Dienst benötigt eine kurze Pause. Bitte versuche es in wenigen Minuten erneut.",
  AUTH_INVALID_TOKEN_USER_TEXT:
    "Die Anmeldung beim KI-Dienst ist fehlgeschlagen. Melde dich unter Modelle in der OpenClaw-App erneut an oder führe `openclaw configure` aus.",
  TLS_CERTIFICATE_ERROR_USER_TEXT:
    "Die sichere Verbindung zum KI-Dienst ist fehlgeschlagen. Details findest du unter Einstellungen → Protokolle in der OpenClaw-App oder mit `openclaw logs --follow`.",
  OAUTH_REFRESH_CONTENTION_USER_TEXT:
    "Eine andere Anmeldung läuft noch. Warte kurz und versuche es dann erneut.",
  SELECTED_AUTH_PROFILE_UNAVAILABLE_USER_TEXT:
    "Diese gespeicherte Anmeldung ist nicht verfügbar. Wähle unter Modelle in der OpenClaw-App eine andere Anmeldung oder führe `openclaw configure` aus.",
  MODEL_CAPACITY_ERROR_USER_MESSAGE:
    "⚠️ Das gewählte Modell ist ausgelastet. Wähle ein anderes Modell oder versuche es später erneut.",
  OVERLOADED_ERROR_USER_MESSAGE:
    "Der KI-Dienst ist vorübergehend überlastet. Bitte versuche es gleich noch einmal.",
  PROVIDER_PROMPT_SIZE_LIMIT_USER_MESSAGE:
    "⚠️ Die Anfrage überschreitet die Größenbegrenzung des Anbieters. Kürze sie oder wähle ein Modell mit einem größeren Limit.",
  GENERIC_EXTERNAL_RUN_FAILURE_TEXT:
    "⚠️ OpenClaw konnte diese Anfrage nicht abschließen. Prüfe den Gesprächsverlauf, bevor du es erneut versuchst. Details findest du unter Einstellungen → Protokolle oder mit `openclaw logs --follow`.",
  PROVIDER_CONVERSATION_STATE_ERROR_USER_MESSAGE:
    "⚠️ Der Modellanbieter hat den Gesprächszustand abgewiesen. Versuche es erneut oder starte mit /new ein neues Gespräch.",
  PROVIDER_RATE_LIMIT_OR_QUOTA_ERROR_USER_MESSAGE:
    "⚠️ Der KI-Dienst kann gerade keine weiteren Anfragen annehmen. Warte einige Minuten. Prüfe bei anhaltenden Problemen die Nutzungs- und Abrechnungslimits deines Kontos.",
  PROVIDER_INTERNAL_ERROR_USER_MESSAGE:
    "⚠️ Beim Modellanbieter ist vor der Antwort ein vorübergehender interner Fehler aufgetreten. Versuche es gleich erneut oder wähle ein anderes Modell.",
  PROVIDER_MODEL_UNAVAILABLE_USER_MESSAGE:
    "⚠️ Dieses Modell wurde nicht gefunden. Wähle ein anderes Modell in der OpenClaw-App oder führe `openclaw configure` aus.",
};

export function messageCopy(locale: string | undefined, key: MessageKey): string {
  return resolveMessageLocale(locale) === "de" ? german[key] : english[key];
}
