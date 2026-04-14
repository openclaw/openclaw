export function checkLength(desc) {
  if (desc.length < 50) return { ok: false, reason: 'too_short' };
  if (desc.length > 500) return { ok: false, reason: 'too_long' };
  return { ok: true };
}

export function checkStuffing(desc) {
  const words = desc.toLowerCase().match(/\b[a-z]{3,}\b/g) || [];
  const counts = {};
  for (const w of words) counts[w] = (counts[w] || 0) + 1;
  const offender = Object.entries(counts).find(([, c]) => c >= 5);
  return offender
    ? { ok: false, reason: 'keyword_stuffing', word: offender[0], count: offender[1] }
    : { ok: true };
}

// Lightweight bag-of-words cosine similarity. Sufficient for v1 tripwire;
// post-v1 can swap for real embeddings.
export function checkDrift(oldDesc, newDesc, threshold = 0.5) {
  const toBag = s => {
    const bag = {};
    for (const w of (s.toLowerCase().match(/\b[a-z]{3,}\b/g) || [])) bag[w] = (bag[w] || 0) + 1;
    return bag;
  };
  const a = toBag(oldDesc), b = toBag(newDesc);
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  let dot = 0, magA = 0, magB = 0;
  for (const k of keys) {
    const va = a[k] || 0, vb = b[k] || 0;
    dot += va * vb;
    magA += va * va;
    magB += vb * vb;
  }
  const similarity = (magA && magB) ? dot / (Math.sqrt(magA) * Math.sqrt(magB)) : 0;
  return { ok: similarity >= threshold, similarity };
}
