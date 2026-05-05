function normalizePhotoUrls(photoUrls) {
  return [...new Set((Array.isArray(photoUrls) ? photoUrls : [])
    .map(value => String(value || '').trim())
    .filter(Boolean))];
}

function fileNameForUrl(url) {
  try {
    const parsed = new URL(url);
    const parts = parsed.pathname.split('/');
    return parts[parts.length - 1] || '';
  } catch (_) {
    return url.split('/').pop() || '';
  }
}

function parseUploadIndex(fileName) {
  const match = /_(\d+)\.[a-z0-9]+$/i.exec(fileName || '');
  if (!match) return null;
  return Number(match[1]);
}

function scorePhoto(url, arrayIndex, totalCount) {
  const fileName = fileNameForUrl(url).toLowerCase();
  const uploadIndex = parseUploadIndex(fileName);
  let score = 55;

  score += Math.max(0, 16 - (arrayIndex * 3));
  if (uploadIndex !== null) {
    score += Math.max(0, 12 - (uploadIndex * 3));
  }
  if (/detail|close|zipper|seam|fabric|swatch|inside/.test(fileName)) {
    score -= 18;
  }
  if (/front|full|angle|hero|finished/.test(fileName)) {
    score += 10;
  }
  if (totalCount >= 4 && arrayIndex === 0) {
    score += 4;
  }

  return {
    url,
    score,
    rank_reason: uploadIndex !== null
      ? `Heuristic rank from upload order index ${uploadIndex}`
      : `Heuristic rank from completion photo order ${arrayIndex + 1}`
  };
}

function rankCompletionPhotos(photoUrls) {
  const normalized = normalizePhotoUrls(photoUrls);
  const ranked = normalized
    .map((url, index) => scorePhoto(url, index, normalized.length))
    .sort((left, right) => right.score - left.score);

  return {
    photoCount: normalized.length,
    heroImage: ranked[0] ? {
      url: ranked[0].url,
      score: ranked[0].score,
      why: ranked[0].rank_reason
    } : null,
    carouselOrder: ranked.map(entry => entry.url),
    photoScores: ranked
  };
}

function computeQualityScore(context) {
  let score = 0;
  score += Math.min(context.photoCount || 0, 6) * 8;
  if (context.heroImage) score += 10;
  if (context.descriptionPresent) score += 12;
  score += Math.min(context.materialCount || 0, 3) * 4;
  score += Math.min(context.dimensionCount || 0, 2) * 4;
  if (context.roomPresent) score += 4;
  if (context.projectNamePresent) score += 8;
  score += Math.min(context.specCount || 0, 4) * 2;
  score += Math.min(context.contactCount || 0, 2) * 2;
  return Math.max(0, Math.min(100, Math.round(score)));
}

module.exports = {
  rankCompletionPhotos,
  computeQualityScore
};
