import { FOUNDATION_CHROME_WEB_STORE_EXTENSION_ID } from "./extension-install-external.js";

function expectedExtensionIds(extensionIds: string[]): string[] {
  // The Store ID also authorizes trusted unpacked builds that preserve it;
  // it never proves that an arbitrary extension path is OpenClaw-owned.
  return [...new Set([...extensionIds, FOUNDATION_CHROME_WEB_STORE_EXTENSION_ID])].toSorted();
}

export function expectedOriginsForExtensionIds(extensionIds: string[]): string[] {
  return expectedExtensionIds(extensionIds).map(
    (extensionId) => `chrome-extension://${extensionId}/`,
  );
}

function pathDerivedExtensionIds(extensionIds: string[]): string[] {
  return extensionIds.filter(
    (extensionId) => extensionId !== FOUNDATION_CHROME_WEB_STORE_EXTENSION_ID,
  );
}

export function isSafeOriginMigration(existingIds: string[], desiredPathIds: string[]): boolean {
  const existingPathIds = pathDerivedExtensionIds(existingIds).toSorted();
  const desiredIds = [...new Set(desiredPathIds)].toSorted();
  if (JSON.stringify(existingPathIds) === JSON.stringify(desiredIds)) {
    return true;
  }
  const removed = existingPathIds.filter((id) => !desiredIds.includes(id));
  const added = desiredIds.filter((id) => !existingPathIds.includes(id));
  const overlap = existingPathIds.some((id) => desiredIds.includes(id));
  return (
    existingPathIds.length === desiredIds.length &&
    removed.length === 1 &&
    added.length === 1 &&
    overlap
  );
}
