export function assertFeishuApiSuccess(
  response: { code?: number; msg?: string },
  errorPrefix?: string,
): void {
  if (response.code !== 0) {
    throw new Error(
      errorPrefix === undefined
        ? response.msg
        : `${errorPrefix}: ${response.msg || `code ${response.code}`}`,
    );
  }
}
