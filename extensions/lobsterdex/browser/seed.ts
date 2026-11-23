// Preserve the established UTF-16 seed contract when catalog ownership moves.
/** FNV-1a over JavaScript UTF-16 code units. */
export function fnv1aUtf16(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

// One salt per page load: revisiting the UI re-rolls every session's lobster,
// while re-renders within a load stay stable for a given session key.
const LOAD_SALT = Math.trunc(Math.random() * 0xffffffff);

export function lobsterPetSeed(sessionKey: string): number {
  return (fnv1aUtf16(sessionKey) ^ LOAD_SALT) >>> 0;
}
