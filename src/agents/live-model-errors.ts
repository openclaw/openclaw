export function isModelNotFoundErrorMessage(raw: string): boolean {
  const msg = raw.trim();
  if (!msg) {
    return false;
  }
  if (/\b404\b/.test(msg) && /not(?:[_\-\s])?found/i.test(msg)) {
    return true;
  }
  if (/not_found_error/i.test(msg)) {
    return true;
  }
  if (/model:\s*[a-z0-9._-]+/i.test(msg) && /not(?:[_\-\s])?found/i.test(msg)) {
    return true;
  }
  if (/does not exist or you do not have access/i.test(msg)) {
    return true;
  }
  if (/deprecated/i.test(msg) && /(upgrade|transition) to/i.test(msg)) {
    return true;
  }
  if (/stealth model/i.test(msg) && /find it here/i.test(msg)) {
    return true;
  }
  if (/is not a valid model id/i.test(msg)) {
    return true;
  }
  return false;
}

export function isMiniMaxModelNotFoundErrorMessage(raw: string): boolean {
  const msg = raw.trim();
  if (!msg) {
    return false;
  }
  return /\b404\b.*\bpage not found\b/i.test(msg);
}
