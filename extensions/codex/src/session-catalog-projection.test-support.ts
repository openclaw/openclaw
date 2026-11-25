import { sanitizeTerminalText } from "openclaw/plugin-sdk/text-chunking";
import type { CodexThreadListResponse } from "./app-server/protocol.js";
import { projectCodexCatalogNativeThread } from "./session-catalog-native-projection.js";
import { projectCodexCatalogPage } from "./session-catalog-projection.js";

/** Raw fixtures enter through the same native metadata boundary as transport responses. */
export function projectNativeCatalogFixture(
  response: CodexThreadListResponse,
  options: { sanitize: typeof sanitizeTerminalText; localSessionsRoot?: string } = {
    sanitize: sanitizeTerminalText,
  },
) {
  return projectCodexCatalogPage(
    {
      ...response,
      data: response.data.map((thread) =>
        projectCodexCatalogNativeThread(thread, options.sanitize),
      ),
    },
    { localSessionsRoot: options.localSessionsRoot },
  );
}
