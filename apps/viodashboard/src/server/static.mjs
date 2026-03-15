import fs from 'node:fs';
import path from 'node:path';
import { PROJECT_ROOT, PUBLIC_DIR, VIO_CAM_DIR } from '../config.mjs';
import { sendText } from './httpUtils.mjs';

export function serveWorkspaceAvatar(requestUrl, res) {
  try {
    const relName = decodeURIComponent(requestUrl.pathname.replace('/avatars/', ''));
    const avatarsRoot = path.join(PROJECT_ROOT, 'avatars');
    const abs = path.join(avatarsRoot, relName);
    if (!abs.startsWith(avatarsRoot)) {throw new Error('forbidden');}
    const data = fs.readFileSync(abs);
    const ext = path.extname(abs).toLowerCase();
    const type = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    res.end(data);
  } catch {
    sendText(res, 404, 'not found');
  }
}

export function serveCameraAsset(requestUrl, res) {
  try {
    const relName = decodeURIComponent(requestUrl.pathname.replace('/vio_cam/', ''));
    const abs = path.join(VIO_CAM_DIR, relName);
    if (!abs.startsWith(VIO_CAM_DIR)) {throw new Error('forbidden');}
    const data = fs.readFileSync(abs);
    const ext = path.extname(abs).toLowerCase();
    const type = ext === '.png' ? 'image/png' : 'image/jpeg';
    res.writeHead(200, { 'Content-Type': type });
    res.end(data);
  } catch {
    sendText(res, 404, 'not found');
  }
}

export function servePublicFile(requestUrl, res) {
  const urlPath = requestUrl.pathname === '/' ? '/index.html' : requestUrl.pathname;
  const filePath = path.join(PUBLIC_DIR, urlPath);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    sendText(res, 403, 'forbidden');
    return;
  }

  fs.readFile(filePath, 'utf8', (err, text) => {
    if (err) {
      sendText(res, 404, 'not found');
      return;
    }
    const ext = path.extname(filePath);
    const types = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.webp': 'image/webp',
    };

    if (urlPath === '/index.html') {
      try {
        const css = fs.readFileSync(path.join(PUBLIC_DIR, 'styles.css'), 'utf8');
        const injected = text.replace('</head>', `<style data-inline-main-css="1">\n${css}\n</style>\n</head>`);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(injected);
        return;
      } catch {}
    }

    res.writeHead(200, { 'Content-Type': types[ext] || 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(text);
  });
}
