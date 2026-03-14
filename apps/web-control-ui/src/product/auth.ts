const TOKEN_PARAM_KEY = "token";
const SESSION_KEY = "openclaw.web-control-ui.gateway-token";

function readHashToken(): string | null {
  const hash = window.location.hash || "";
  const normalized = hash.startsWith("#") ? hash.slice(1) : hash;
  const params = new URLSearchParams(normalized);
  const token = params.get(TOKEN_PARAM_KEY)?.trim();
  return token || null;
}

function clearTokenFromUrl() {
  if (!window.location.hash) {
    return;
  }
  const url = new URL(window.location.href);
  url.hash = "";
  window.history.replaceState({}, "", url.toString());
}

export function loadInitialGatewayToken(): string {
  const fromHash = readHashToken();
  if (fromHash) {
    window.sessionStorage.setItem(SESSION_KEY, fromHash);
    clearTokenFromUrl();
    return fromHash;
  }
  return window.sessionStorage.getItem(SESSION_KEY)?.trim() || "";
}

export function persistGatewayToken(token: string) {
  const trimmed = token.trim();
  if (trimmed) {
    window.sessionStorage.setItem(SESSION_KEY, trimmed);
  } else {
    window.sessionStorage.removeItem(SESSION_KEY);
  }
}
