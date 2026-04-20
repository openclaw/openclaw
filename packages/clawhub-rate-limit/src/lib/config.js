module.exports = {
  windowSec: parseInt(process.env.RATE_LIMIT_WINDOW_SEC, 10) || 60,
  maxRequests: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS, 10) || 100,
};
