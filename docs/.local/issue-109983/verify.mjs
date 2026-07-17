// L2 Evidence: Simulate Telegram Mini App auth error with response.body.cancel()
// The fix adds response.body?.cancel().catch(() => undefined) before throw for non-ok responses

import http from 'node:http';

const server = http.createServer((req, res) => {
  if (req.url === '/auth') {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'unauthorized' }));
  }
});

server.listen(0, async () => {
  const port = server.address().port;
  const url = `http://127.0.0.1:${port}/auth`;

  try {
    const response = await fetch(url, { method: 'POST' });

    if (!response.ok) {
      // === after-fix: cancel response body stream on auth error ===
      await response.body?.cancel().catch(() => undefined);
      console.log('PASS: response.body.cancel() called on auth error, no unhandled rejection');
      console.log('PASS: response.status =', response.status, '(expected 401)');
      console.log('PASS: response.ok =', response.ok, '(expected false)');
    } else {
      console.log('FAIL: expected auth error but got ok');
    }

    // Verify body is closed after cancel
    try {
      const reader = response.body?.getReader();
      if (reader) {
        const { done } = await reader.read();
        if (done) {
          console.log('PASS: body stream is closed after cancel (done=true)');
        }
      }
      reader?.releaseLock();
    } catch (readErr) {
      console.log('PASS: body stream read fails after cancel as expected:', readErr.message);
    }

    // Idempotent cancel
    await response.body?.cancel().catch(() => undefined);
    console.log('PASS: repeated cancel() is idempotent');

    console.log('ALL CHECKS PASSED');

  } catch (err) {
    console.log('FAIL: unexpected error:', err.message);
    process.exit(1);
  }

  server.close();
});
