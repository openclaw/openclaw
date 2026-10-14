/**
 * @typedef {{ text: string, truncatedChars: number }} BoundedTail
 */

/**
 * @param {BoundedTail} state
 * @param {unknown} chunk
 * @param {number} maxChars
 * @returns {BoundedTail}
 */
export function appendBoundedTail(state, chunk, maxChars) {
  const nextText = state.text + String(chunk);
  const droppedChars = Math.max(0, nextText.length - maxChars);
  return {
    text: droppedChars > 0 ? nextText.slice(droppedChars) : nextText,
    truncatedChars: state.truncatedChars + droppedChars,
  };
}

/** @param {BoundedTail} state */
export function formatBoundedTail(state) {
  if (state.truncatedChars === 0) {
    return state.text;
  }
  return `[output truncated ${state.truncatedChars} chars; showing tail]\n${state.text}`;
}
