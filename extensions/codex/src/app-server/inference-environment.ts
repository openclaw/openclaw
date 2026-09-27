export function supportsInferenceEnvironment(native: NodeJS.ProcessEnv): boolean {
  if (native.CODEX_CA_CERTIFICATE?.trim() || native.SSL_CERT_FILE?.trim()) {
    return false;
  }
  const names = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY"];
  for (const upper of names) {
    const lower = upper.toLowerCase();
    if (
      native[upper] !== process.env[upper] ||
      native[lower] !== process.env[lower] ||
      (native[upper] !== undefined &&
        native[lower] !== undefined &&
        native[upper] !== native[lower])
    ) {
      return false;
    }
  }
  const value = (name: string) => (native[name] ?? native[name.toLowerCase()])?.trim() || undefined;
  const http = value("HTTP_PROXY");
  const https = value("HTTPS_PROXY");
  const all = value("ALL_PROXY");
  if (!http && !https && !all) {
    return true;
  }
  const noProxy = native.NO_PROXY ?? native.no_proxy ?? "";
  if (noProxy === "*") {
    return true;
  }
  if (
    native.REQUEST_METHOD !== undefined ||
    names.slice(0, 3).some((name) => {
      const raw = native[name] ?? native[name.toLowerCase()];
      return raw !== undefined && raw !== raw.trim();
    })
  ) {
    return false;
  }
  // Reqwest prefers uppercase and has no HTTP_PROXY fallback for HTTPS. Only
  // equivalent proxy selection and literal loopback bypasses are qualified here.
  if ((https ?? all) !== (https ?? http ?? all)) {
    return false;
  }
  const bypasses = noProxy
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (bypasses.some((entry) => !["127.0.0.1", "localhost", "::1", "[::1]"].includes(entry))) {
    return false;
  }
  if ((http || all) && !bypasses.includes("127.0.0.1")) {
    return false;
  }
  return /^https?:\/\//.test(https ?? all ?? "");
}
