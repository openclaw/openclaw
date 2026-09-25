export function decodeAcpxSessionRecordId(fileName: string): string | undefined {
  try {
    return decodeURIComponent(fileName.slice(0, -".json".length));
  } catch {
    return undefined;
  }
}
