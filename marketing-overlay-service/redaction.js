const STREET_SUFFIXES = [
  'street', 'st', 'avenue', 'ave', 'boulevard', 'blvd', 'road', 'rd',
  'drive', 'dr', 'lane', 'ln', 'way', 'court', 'ct', 'place', 'pl',
  'terrace', 'ter', 'parkway', 'pkwy'
];

function normalizeText(value) {
  return String(value || '')
    .replace(/\r/g, '')
    .trim();
}

function collapseInlineWhitespace(text) {
  return String(text || '')
    .split('\n')
    .map(line => line.replace(/[ \t]+/g, ' ').trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function collectDefaultRedactions(item) {
  const applied = [];
  if (normalizeText(item.special_notes) || normalizeText(item.fabrication_notes) || normalizeText(item.construction_notes)) {
    applied.push('internal_notes_excluded');
  }
  return applied;
}

function buildSensitiveTerms(context) {
  const terms = [];
  const clientName = normalizeText(context?.clientName);
  const projectName = normalizeText(context?.projectName);
  if (clientName) terms.push(clientName);
  if (projectName) terms.push(projectName);
  return [...new Set(terms.filter(term => term.length >= 3))];
}

function stripAddressLikeDetails(text, applied) {
  let next = text;
  const streetPattern = new RegExp(`\\b\\d{1,5}\\s+[A-Za-z0-9.'#\\-\\s]{2,40}\\s(?:${STREET_SUFFIXES.join('|')})\\b`, 'gi');
  if (streetPattern.test(next)) {
    next = next.replace(streetPattern, 'private location');
    applied.push('location_removed');
  }

  const cityStatePattern = /\b[A-Z][a-z]+(?:\s[A-Z][a-z]+)*,\s*(?:AL|AK|AZ|AR|CA|CO|CT|DC|DE|FL|GA|HI|IA|ID|IL|IN|KS|KY|LA|MA|MD|ME|MI|MN|MO|MS|MT|NC|ND|NE|NH|NJ|NM|NV|NY|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VA|VT|WA|WI|WV|WY|California)\b/g;
  if (cityStatePattern.test(next)) {
    next = next.replace(cityStatePattern, 'private location');
    applied.push('location_removed');
  }

  const zipPattern = /\b\d{5}(?:-\d{4})?\b/g;
  if (zipPattern.test(next)) {
    next = next.replace(zipPattern, 'private area');
    applied.push('location_removed');
  }

  return next;
}

function sanitizePublicText(value, context) {
  let text = collapseInlineWhitespace(normalizeText(value));
  const applied = [];
  if (!text) {
    return { text: '', redactions_applied: applied };
  }

  for (const term of buildSensitiveTerms(context)) {
    const matcher = new RegExp(`\\b${escapeRegExp(term)}\\b`, 'gi');
    if (matcher.test(text)) {
      text = text.replace(matcher, 'private client');
      applied.push('client_name_removed');
    }
  }

  text = stripAddressLikeDetails(text, applied);
  text = text
    .replace(/[ \t]+([.,;:!?])/g, '$1')
    .replace(/\bprivate client project project\b/gi, 'private client project')
    .trim();
  text = collapseInlineWhitespace(text);

  return {
    text,
    redactions_applied: [...new Set(applied)]
  };
}

module.exports = {
  sanitizePublicText,
  collectDefaultRedactions
};
