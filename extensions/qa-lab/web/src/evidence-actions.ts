import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { readNonBlankString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { getJson } from "./http.js";
import { redactSensitiveText } from "./ui-render-capture-redaction.js";
import type { EvidenceEnvelope, UiState } from "./ui-types.js";

export function readInitialEvidencePath(url: URL): string {
  return (
    readNonBlankString(url.searchParams.get("evidencePath")) ||
    readNonBlankString(url.searchParams.get("path")) ||
    ""
  );
}

export async function loadQaEvidence(state: UiState, render: () => void, pathOverride?: string) {
  const evidencePath = readNonBlankString(pathOverride ?? state.evidencePathDraft);
  if (!evidencePath) {
    state.evidenceError = "Evidence path is required.";
    render();
    return;
  }
  state.evidenceLoading = true;
  state.evidenceError = null;
  render();
  try {
    const payload = await getJson<EvidenceEnvelope>(
      `/api/evidence?path=${encodeURIComponent(evidencePath)}`,
    );
    state.evidence = payload.evidence;
    state.evidencePathDraft = payload.evidence?.evidencePath ?? evidencePath;
    state.selectedEvidenceEntryKey = payload.evidence?.entries[0]?.key ?? null;
    const url = new URL(window.location.href);
    url.pathname = "/evidence";
    url.searchParams.set("path", state.evidencePathDraft);
    window.history.replaceState(null, "", `${url.pathname}${url.search}`);
  } catch (error) {
    state.evidence = null;
    state.selectedEvidenceEntryKey = null;
    state.evidenceError = redactSensitiveText(formatErrorMessage(error));
  } finally {
    state.evidenceLoading = false;
    render();
  }
}
