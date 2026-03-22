// Load the native addon and re-export all functions
const native = require('./index.linux-x64-gnu.node');
const crypto = require('crypto');

// Wrapper for randomBytes (not directly exported)
function randomBytes(length) {
  if (length < 0 || length > 10_000_000) {
    throw new Error('Invalid length (max 10MB)');
  }
  return crypto.randomBytes(length);
}

// Wrapper for urlEncode (not directly exported)
function urlEncode(input) {
  if (typeof input !== 'string') {
    throw new Error('Input must be a string');
  }
  if (input.length > 10_000_000) {
    throw new Error('Input too large (max 10MB)');
  }
  return encodeURIComponent(input);
}

// Re-export all functions with wrappers
module.exports = {
  ...native,
  randomBytes,
  urlEncode,
};
