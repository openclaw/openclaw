// approval-server.mjs — tiny HTTP server, token-gated, 2hr TTL
import http from 'node:http';
import { createGitOps } from './lib/git-ops.mjs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendFileSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = 9876;
const TTL_MS = 2 * 60 * 60 * 1000;

export function startApprovalServer({ branch, date, token, repoDir }) {
  const git = createGitOps(repoDir);
  const server = http.createServer(async (req, res) => {
    const origin = req.headers.origin;
    if (origin && !origin.startsWith('http://localhost') && !origin.startsWith('http://127.0.0.1') && !origin.startsWith('file://')) {
      res.writeHead(403); res.end('bad origin'); return;
    }
    const url = new URL(req.url, `http://localhost:${PORT}`);
    if (url.searchParams.get('token') !== token) {
      res.writeHead(403); res.end('forbidden'); return;
    }
    try {
      if (url.pathname === '/approve') {
        await git.squashMergeToMain(branch);
        appendFileSync(join(__dirname, 'autoresearch-log.md'), `| ${date} | approved |\n`);
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<h1>Approved and merged. You can close this tab.</h1>');
        setTimeout(() => server.close(), 500);
      } else if (url.pathname === '/reject') {
        await git.deleteBranch(branch);
        appendFileSync(join(__dirname, 'autoresearch-log.md'), `| ${date} | rejected |\n`);
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<h1>Rejected and branch deleted.</h1>');
        setTimeout(() => server.close(), 500);
      } else {
        res.writeHead(404); res.end();
      }
    } catch (e) {
      res.writeHead(500); res.end(e.message);
    }
  });
  server.listen(PORT, '127.0.0.1');
  const killTimer = setTimeout(() => server.close(), TTL_MS);
  server.on('close', () => clearTimeout(killTimer));
  return server;
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}`) {
  const mode = process.argv[2];
  const date = process.argv[3];
  if (!['--approve', '--reject'].includes(mode) || !date) {
    console.error('Usage: node approval-server.mjs --approve|--reject YYYY-MM-DD');
    process.exit(1);
  }
  const git = createGitOps(join(__dirname, '..', '..'));
  const branch = `autoresearch/${date}`;
  const action = mode === '--approve' ? git.squashMergeToMain(branch) : git.deleteBranch(branch);
  action.then(() => console.log('done')).catch(e => { console.error(e); process.exit(1); });
}
