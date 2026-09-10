import type { StreamFn } from "@openclaw/ai";

type AnthropicTransportModule = typeof import("@openclaw/ai/transports");
type AnthropicTransportImporter = () => Promise<AnthropicTransportModule>;

function isMissingTransportExport(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    error.code === "ERR_PACKAGE_PATH_NOT_EXPORTED" &&
    error.message.includes("@openclaw/ai") &&
    error.message.includes("transports")
  );
}

export async function loadAnthropicTransportStream(
  importer: AnthropicTransportImporter = () => import("@openclaw/ai/transports"),
): Promise<StreamFn | undefined> {
  try {
    const module = await importer();
    return module.createAnthropicMessagesTransportStreamFn();
  } catch (error) {
    if (isMissingTransportExport(error)) {
      return undefined;
    }
    throw error;
  }
}
