export function isLikelyEmailAddress(value: string): boolean {
  return /^[^\s@<>()[\]`]+@[^\s@<>()[\]`]+\.[^\s@<>()[\]`]+$/.test(value);
}
