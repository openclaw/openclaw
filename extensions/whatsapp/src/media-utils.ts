export function shouldSendAsPtt(contentType?: string | null): boolean {
  if (typeof contentType !== "string") {
    return false;
  }
  const normalized = contentType.trim().toLowerCase();
  return (
    normalized === "audio/ogg" || normalized.startsWith("audio/ogg;") || normalized === "audio/opus"
  );
}
