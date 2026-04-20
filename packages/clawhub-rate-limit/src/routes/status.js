const { checkAndIncrement } = require('../lib/rateCounter');
const { windowSec } = require('../lib/config');

/**
 * Status endpoint — queries Redis directly so it works regardless of
 * middleware ordering and doesn't consume the caller's own quota.
 */
async function statusRoute(req, res) {
  const userId = req.user?.id || req.ip;
  const key = `rl:${userId}`;

  try {
    const info = await checkAndIncrement(key);
    res.json({
      limit: info.limit,
      remaining: info.remaining,
      reset: info.resetAt,
      windowSec,
    });
  } catch (err) {
    res.status(503).json({ error: 'Rate limit info unavailable' });
  }
}

module.exports = { statusRoute };
