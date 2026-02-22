const CODES = require('./reason-codes.cjs');

const TAXONOMY = {
  [CODES.POLICY_MISSING]: { class: 'policy', severity: 'critical', httpStatus: 500 },
  [CODES.POLICY_INVALID]: { class: 'policy', severity: 'critical', httpStatus: 500 },
  [CODES.CHAIN_DENIED]: { class: 'request', severity: 'error', httpStatus: 403 },
  [CODES.ASSET_DENIED]: { class: 'request', severity: 'error', httpStatus: 403 },
  [CODES.RECIPIENT_DENIED]: { class: 'request', severity: 'error', httpStatus: 403 },
  [CODES.PER_TX_EXCEEDED]: { class: 'limits', severity: 'error', httpStatus: 429 },
  [CODES.DAILY_CAP_EXCEEDED]: { class: 'limits', severity: 'error', httpStatus: 429 },
  [CODES.RATE_LIMITED]: { class: 'limits', severity: 'error', httpStatus: 429 },
  [CODES.ACTION_DENIED]: { class: 'policy', severity: 'error', httpStatus: 403 },
  [CODES.SERVICE_NOT_FOUND]: { class: 'request', severity: 'error', httpStatus: 404 },
  [CODES.WALLET_UNDERFUNDED]: { class: 'limits', severity: 'error', httpStatus: 402 },
};

function mapReasonCode(reasonCode) {
  return TAXONOMY[reasonCode] || { class: 'unknown', severity: 'error', httpStatus: 500 };
}

module.exports = {
  TAXONOMY,
  mapReasonCode,
};
