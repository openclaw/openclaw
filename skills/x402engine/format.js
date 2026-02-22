// Portable USD / percentage formatters.
// Ported from x402-price-bot/src/format.js

export function formatUsd(n) {
  const num = Number(n);
  if (!Number.isFinite(num)) return 'n/a';

  const abs = Math.abs(num);
  let maximumFractionDigits = 2;
  if (abs >= 1000) maximumFractionDigits = 0;
  if (abs >= 1e9) maximumFractionDigits = 2;

  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits,
  }).format(num);
}

export function formatCompactUsd(n) {
  const num = Number(n);
  if (!Number.isFinite(num)) return 'n/a';

  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    notation: 'compact',
    compactDisplay: 'short',
    maximumFractionDigits: 2,
  }).format(num);
}

export function formatPct(n) {
  const num = Number(n);
  if (!Number.isFinite(num)) return 'n/a';
  const sign = num > 0 ? '+' : '';
  return `${sign}${num.toFixed(2)}%`;
}
