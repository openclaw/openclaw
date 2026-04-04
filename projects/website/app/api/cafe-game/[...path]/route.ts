import { NextRequest, NextResponse } from 'next/server';
import { readFile } from 'fs/promises';
import { join } from 'path';

const ALLOWED_JS = new Set([
  'map.js', 'tiles.js', 'sprites.js', 'npc-data.js',
  'engine.js', 'engine-pixi.js', 'dialogue.js', 'touch.js', 'ambience.js',
  'audio.js', 'behavior.js', 'soundscape.js', 'interactions.js', 'scroll-dispenser.js',
  'notebook.js', 'cafe-data-public.json',
]);

const MIME: Record<string, string> = {
  js: 'application/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  png: 'image/png',
  jpg: 'image/jpeg',
};

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  const { path } = await params;

  // Block path traversal
  if (path.some(p => p.includes('..'))) {
    return new NextResponse('Not found', { status: 404 });
  }

  // Route 1: top-level game files (e.g. "audio.js")
  if (path.length === 1 && ALLOWED_JS.has(path[0])) {
    const ext = path[0].split('.').pop() || '';
    const contentType = MIME[ext] || 'application/octet-stream';
    try {
      const filePath = join(process.cwd(), 'public', 'cafe-game', path[0]);
      const data = await readFile(filePath);
      return new NextResponse(data, {
        headers: {
          'Content-Type': contentType,
          'Cache-Control': 'public, max-age=0, must-revalidate',
          'Access-Control-Allow-Origin': '*',
        },
      });
    } catch {
      return new NextResponse('Not found', { status: 404 });
    }
  }

  // Route 2: data (e.g. "data/briefing.json")
  if (path.length === 2 && path[0] === 'data') {
    const file = path[1];
    if (!file.endsWith('.json')) {
      return new NextResponse('Not found', { status: 404 });
    }
    try {
      const filePath = join(process.cwd(), 'public', 'cafe-game', 'data', file);
      const data = await readFile(filePath);
      return new NextResponse(data, {
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'public, max-age=0, must-revalidate',
          'Access-Control-Allow-Origin': '*',
        },
      });
    } catch {
      return new NextResponse('Not found', { status: 404 });
    }
  }

  // Route 3: assets (e.g. "assets/latest_ambience.mp3")
  if (path.length === 2 && path[0] === 'assets') {
    const file = path[1];
    const ext = file.split('.').pop() || '';
    if (!['mp3', 'wav', 'ogg', 'png', 'jpg', 'json'].includes(ext)) {
      return new NextResponse('Not found', { status: 404 });
    }
    try {
      const filePath = join(process.cwd(), 'public', 'cafe-game', 'assets', file);
      const data = await readFile(filePath);
      return new NextResponse(data, {
        headers: {
          'Content-Type': MIME[ext] || 'application/octet-stream',
          'Cache-Control': 'public, max-age=3600',
          'Access-Control-Allow-Origin': '*',
        },
      });
    } catch {
      return new NextResponse('Not found', { status: 404 });
    }
  }

  // Route 3: assets/units (e.g. "assets/units/k_00.mp3")
  if (path.length === 3 && path[0] === 'assets' && path[1] === 'units') {
    const file = path[2];
    const ext = file.split('.').pop() || '';
    if (!['mp3', 'wav', 'ogg'].includes(ext)) {
      return new NextResponse('Not found', { status: 404 });
    }
    try {
      const filePath = join(process.cwd(), 'public', 'cafe-game', 'assets', 'units', file);
      const data = await readFile(filePath);
      return new NextResponse(data, {
        headers: {
          'Content-Type': MIME[ext],
          'Cache-Control': 'public, max-age=3600',
          'Access-Control-Allow-Origin': '*',
        },
      });
    } catch {
      return new NextResponse('Not found', { status: 404 });
    }
  }

  return new NextResponse('Not found', { status: 404 });
}
