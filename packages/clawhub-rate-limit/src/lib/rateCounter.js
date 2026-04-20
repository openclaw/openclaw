const { redis } = require('./redis');
const { windowSec, maxRequests } = require('./config');

/**
 * Sliding window rate counter using Redis sorted sets.
 * Returns { count, limit, remaining, resetAt }.
 */
async function checkAndIncrement(key) {
  const now = Date.now();
  const windowMs = windowSec * 1000;
  const windowStart = now - windowMs;
  const resetAt = Math.ceil((now + windowMs) / 1000);

  const multi = redis.multi();
  multi.zremrangebyscore(key, 0, windowStart);
  multi.zadd(key, now, `${now}:${Math.random()}`);
  multi.zcard(key);
  multi.expire(key, windowSec + 1);

  const results = await multi.exec();
  const count = results[2][1];

  return {
    count,
    limit: maxRequests,
    remaining: Math.max(0, maxRequests - count),
    resetAt,
  };
}

module.exports = { checkAndIncrement };
