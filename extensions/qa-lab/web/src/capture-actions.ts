import { postJson } from "./http.js";
import type { UiState } from "./ui-types.js";

export async function deleteCaptureData(
  state: UiState,
  refresh: () => Promise<void>,
  sessionIds?: string[],
) {
  if (sessionIds?.length === 0) {
    return;
  }
  const confirmed = window.confirm(
    sessionIds
      ? `Delete ${sessionIds.length} selected capture session${sessionIds.length === 1 ? "" : "s"}?`
      : "Purge all captured sessions, events, and blobs?",
  );
  if (!confirmed) {
    return;
  }
  await postJson(
    sessionIds ? "/api/capture/delete-sessions" : "/api/capture/purge",
    sessionIds ? { sessionIds } : {},
  );
  state.selectedCaptureSessionIds = [];
  state.selectedCaptureEventKey = null;
  await refresh();
}
