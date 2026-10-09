/** Validates base64 structure and returns its decoded size without allocating a decode buffer. */
export function inspectStrictBase64(value: string): number | undefined {
  const match = /^[A-Za-z0-9+/_-]*={0,2}$/u.exec(value);
  // `$` also matches before a final line break; base64 input must consume every byte.
  if (!match || match[0].length !== value.length) {
    return undefined;
  }
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  const dataChars = value.length - padding;
  const remainder = dataChars % 4;
  if (padding === 0) {
    return remainder === 1 ? undefined : Math.floor((dataChars * 3) / 4);
  }
  if ((padding === 1 && remainder !== 3) || (padding === 2 && remainder !== 2)) {
    return undefined;
  }
  return Math.floor((dataChars * 3) / 4);
}
