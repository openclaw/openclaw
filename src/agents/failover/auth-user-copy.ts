import { resolveMessageLocale } from "../../shared/message-locale.js";
import type { FailoverReason } from "./signal.js";

type AuthProfileFailureCopyParams = {
  locale?: string;
  reason: FailoverReason;
  provider: string;
  allInCooldown: boolean;
  recoveryHint?: string;
};

const authProfileUnavailableCopy = (provider: string) =>
  `Couldn't reach ${provider} with any of your saved logins right now.`;

const AUTH_PROFILE_COOLDOWN_COPY = {
  auth: (provider: string) =>
    `Couldn't sign in to ${provider}. Your saved login looks expired or no longer works.`,
  auth_permanent: (provider: string) => `${provider} isn't accepting your saved login anymore.`,
  format: authProfileUnavailableCopy,
  rate_limit: (provider: string) =>
    `${provider} is asking us to slow down. Please wait a moment before trying again.`,
  overloaded: (provider: string) =>
    `${provider} is overloaded right now. Please wait a moment before trying again.`,
  billing: (provider: string) =>
    `${provider} rejected the request — looks like a billing issue on the account.`,
  server_error: (provider: string) =>
    `${provider} is having issues right now. Please wait a moment before trying again.`,
  route_unavailable: (provider: string) =>
    `${provider} cannot serve this model right now. Choose another model.`,
  timeout: (provider: string) =>
    `${provider} hasn't been responding. Please wait a moment before trying again.`,
  tls_certificate: authProfileUnavailableCopy,
  context_overflow: authProfileUnavailableCopy,
  model_not_found: (provider: string) => `${provider} can't find the model you're using right now.`,
  session_expired: (provider: string) =>
    `Couldn't sign in to ${provider}. Your saved login looks expired or no longer works.`,
  empty_response: authProfileUnavailableCopy,
  no_error_details: authProfileUnavailableCopy,
  unclassified: authProfileUnavailableCopy,
  unknown: authProfileUnavailableCopy,
} satisfies Record<FailoverReason, (provider: string) => string>;

const AUTH_PROFILE_DIRECT_COPY: Partial<Record<FailoverReason, (provider: string) => string>> = {
  auth: AUTH_PROFILE_COOLDOWN_COPY.auth,
  auth_permanent: (provider) => `${provider} isn't accepting your saved login.`,
  billing: AUTH_PROFILE_COOLDOWN_COPY.billing,
  session_expired: AUTH_PROFILE_COOLDOWN_COPY.session_expired,
};

const AUTH_PROFILE_RECOVERY_REASONS = new Set<FailoverReason>([
  "auth",
  "auth_permanent",
  "billing",
  "context_overflow",
  "session_expired",
  "empty_response",
  "no_error_details",
  "unclassified",
  "unknown",
]);

export function renderAuthProfileFailoverCopy(params: AuthProfileFailureCopyParams): string {
  if (resolveMessageLocale(params.locale) === "de") {
    const descriptions: Partial<Record<FailoverReason, string>> = {
      auth: `Die Anmeldung bei ${params.provider} ist fehlgeschlagen. Deine gespeicherte Anmeldung ist möglicherweise abgelaufen.`,
      auth_permanent: `${params.provider} akzeptiert deine gespeicherte Anmeldung nicht mehr.`,
      session_expired: `Die Anmeldung bei ${params.provider} ist abgelaufen.`,
      billing: `${params.provider} meldet ein Abrechnungsproblem. Prüfe dein Guthaben und die Nutzungslimits.`,
      rate_limit: `${params.provider} benötigt eine kurze Pause. Bitte versuche es gleich erneut.`,
      overloaded: `${params.provider} ist gerade überlastet. Bitte versuche es gleich erneut.`,
      timeout: `${params.provider} antwortet nicht rechtzeitig. Prüfe erledigte Arbeit, bevor du es erneut versuchst.`,
      server_error: `Bei ${params.provider} ist ein Fehler aufgetreten. Bitte versuche es gleich erneut.`,
      route_unavailable: `${params.provider} kann dieses Modell gerade nicht bereitstellen. Wähle ein anderes Modell.`,
      model_not_found: `${params.provider} findet dieses Modell nicht. Wähle ein anderes Modell.`,
    };
    const description =
      descriptions[params.reason] ??
      `Keine deiner gespeicherten Anmeldungen bei ${params.provider} ist gerade verfügbar.`;
    return [
      description,
      AUTH_PROFILE_RECOVERY_REASONS.has(params.reason) ? params.recoveryHint : undefined,
    ]
      .filter(Boolean)
      .join(" ");
  }
  const description = params.allInCooldown
    ? AUTH_PROFILE_COOLDOWN_COPY[params.reason](params.provider)
    : AUTH_PROFILE_DIRECT_COPY[params.reason]?.(params.provider);
  const hint = AUTH_PROFILE_RECOVERY_REASONS.has(params.reason) ? params.recoveryHint : null;
  return [description ?? authProfileUnavailableCopy(params.provider), hint]
    .filter(Boolean)
    .join(" ");
}

export function renderMissingApiKeyReplyCopy(params?: {
  locale?: string;
  provider: string;
  providerGuidance?: boolean;
}): string | null {
  const provider = params?.provider.trim().toLowerCase();
  if (!provider) {
    return null;
  }
  if (resolveMessageLocale(params?.locale) === "de") {
    return provider === "openai" && params?.providerGuidance
      ? "⚠️ OpenAI benötigt für dieses Modell eine andere Anmeldung. Wähle unter Modelle in der OpenClaw-App oder mit `openclaw configure`, wie du dich verbinden möchtest."
      : provider === "openai"
        ? "⚠️ Die Verbindung zu OpenAI ist fehlgeschlagen. Führe `openclaw doctor --fix` aus und versuche es erneut. Prüfe bei erneutem Auftreten die Anmeldung unter Modelle oder mit `openclaw configure`."
        : "⚠️ Dieser KI-Dienst ist noch nicht eingerichtet. Melde dich unter Modelle in der OpenClaw-App an oder führe `openclaw configure` aus.";
  }
  if (provider === "openai" && params?.providerGuidance) {
    return "⚠️ OpenAI needs a different sign-in for this model. Open Models in the OpenClaw app or run `openclaw configure` to choose how to connect.";
  }
  return provider === "openai"
    ? "⚠️ Couldn't connect to OpenAI. Run `openclaw doctor --fix`, then try again. If it still fails, open Models in the OpenClaw app or run `openclaw configure`."
    : "⚠️ This AI service isn't set up yet. Sign in under Models in the OpenClaw app or run `openclaw configure`.";
}
