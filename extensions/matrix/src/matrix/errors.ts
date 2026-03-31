export function isMatrixNotFoundError(err: unknown): boolean {
  const errObj = err as { statusCode?: number; body?: { errcode?: string } };
  if (errObj?.statusCode === 404 || errObj?.body?.errcode === "M_NOT_FOUND") {
    return true;
  }
  const message = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return (
    message.includes("m_not_found") || message.includes("[404]") || message.includes("not found")
  );
}
