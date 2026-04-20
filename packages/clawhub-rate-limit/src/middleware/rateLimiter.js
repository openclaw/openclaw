const { checkAndIncrement } = require('../lib/rateCounter');

function identifyUser(req) {
  // Prefer authenticated identity; fall back to IP to prevent bucket spoofing
  return req.user?.id || req.ip;
}

async function rateLimiter(req, res, next) {
  const userId = identifyUser(req);
  const key = `rl:${userId}`;

  try {
    const info = await checkAndIncrement(key);

    res.set('X-RateLimit-Limit', String(info.limit));
    res.set('X-RateLimit-Remaining', String(info.remaining));
    res.set('X-RateLimit-Reset', String(info.resetAt));

    req.rateLimitInfo = info;

    if (info.remaining <= 0) {
      const retryAfter = Math.max(1, info.resetAt - Math.ceil(Date.now() / 1000));
      res.set('Retry-After', String(retryAfter));
      return res.status(429).json({
        error: 'Too Many Requests',
        limit: info.limit,
        remaining: 0,
        resetAt: info.resetAt,
        retryAfter,
      });
    }

    next();
  } catch (err) {
    console.error('Rate limiter error:', err.message);
    next(); // fail open
  }
}

module.exports = { rateLimiter };
