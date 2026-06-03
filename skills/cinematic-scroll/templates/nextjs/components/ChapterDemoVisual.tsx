/**
 * ChapterDemoVisual — CSS + SVG only.
 *
 * Renders a stunning chapter visual without any fal.ai image. Used as the
 * default when `chapter.background` is undefined so the page looks good on
 * first paint even before the user sets up fal credentials.
 *
 * Visual composition (5 layers, no raster images):
 *   1. atmosphere gradient (from chapter.atmosphere.background)
 *   2. soft mesh gradient built from chapter.visualPrompt.palette
 *   3. historical-layer SVG silhouette (renaissance arch, baroque ribbon, etc.)
 *   4. SVG film-grain via feTurbulence
 *   5. radial vignette
 *
 * Replace by setting `chapter.background = '/generated/<id>.jpg'` after running
 * `node scripts/generate-chapter-assets.mjs`.
 */
import type { EditionChapter } from '@/lib/editions-manifest';

export function ChapterDemoVisual({ chapter, eager: _eager = false }: { chapter: EditionChapter; eager?: boolean }) {
  const palette = chapter.visualPrompt?.palette ?? ['#1a1410', '#3a2a20', '#8a6a4a'];
  // Resolve named palette tokens to actual hex (manifest uses words like "aged cream")
  const accent = chapter.accent;
  const [c1, c2, c3] = [paletteHex(palette[0], accent), paletteHex(palette[1], accent), paletteHex(palette[2] ?? accent, accent)];
  const grainId = `grain-${chapter.id}`;
  const meshId = `mesh-${chapter.id}`;

  return (
    <div className="absolute inset-0 overflow-hidden" aria-hidden>
      {/* Layer 1 — atmosphere base */}
      <div className="absolute inset-0" style={{ background: chapter.atmosphere.background }} />

      {/* Layer 2 — soft mesh gradient from palette */}
      <div
        className="absolute inset-0 opacity-90 mix-blend-screen"
        style={{
          background: `
            radial-gradient(60% 50% at 25% 30%, ${withAlpha(c1, 0.55)}, transparent 60%),
            radial-gradient(50% 60% at 80% 60%, ${withAlpha(c2, 0.45)}, transparent 65%),
            radial-gradient(40% 40% at 60% 85%, ${withAlpha(accent, 0.35)}, transparent 70%)
          `,
        }}
      />

      {/* Layer 3 — historical silhouette */}
      <svg
        className="absolute inset-0 h-full w-full opacity-[0.13]"
        viewBox="0 0 1600 900"
        preserveAspectRatio="xMidYMid slice"
      >
        <defs>
          <linearGradient id={meshId} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor={c1} stopOpacity="0.9" />
            <stop offset="100%" stopColor={c3} stopOpacity="0.4" />
          </linearGradient>
        </defs>
        <HistoricalSilhouette
          layer={chapter.visualPrompt?.historicalLayer ?? 'renaissance'}
          fill={`url(#${meshId})`}
          accent={accent}
        />
      </svg>

      {/* Layer 4 — film grain */}
      <svg className="absolute inset-0 h-full w-full opacity-[0.18] mix-blend-overlay">
        <filter id={grainId}>
          <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" stitchTiles="stitch" />
          <feColorMatrix values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 0.55 0" />
        </filter>
        <rect width="100%" height="100%" filter={`url(#${grainId})`} />
      </svg>

      {/* Layer 5 — radial vignette */}
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_45%,transparent_0%,rgba(0,0,0,0.18)_42%,rgba(0,0,0,0.82)_100%)]" />
    </div>
  );
}

// ─── Historical SVG silhouettes ───────────────────────────────────────────

function HistoricalSilhouette({
  layer,
  fill,
  accent,
}: {
  layer: 'renaissance' | 'baroque' | 'atelier' | 'architectural' | 'industrial';
  fill: string;
  accent: string;
}) {
  switch (layer) {
    case 'renaissance':
      // Classical arch with column outlines
      return (
        <g fill={fill} stroke={accent} strokeWidth="0.5" strokeOpacity="0.3">
          <path d="M 600 900 L 600 380 Q 600 200 800 200 Q 1000 200 1000 380 L 1000 900 Z" />
          <rect x="540" y="380" width="40" height="520" />
          <rect x="1020" y="380" width="40" height="520" />
          <rect x="520" y="360" width="80" height="30" />
          <rect x="1000" y="360" width="80" height="30" />
        </g>
      );
    case 'baroque':
      // Sweeping ribbon / scroll flourish
      return (
        <g fill={fill}>
          <path d="M 100 450 Q 400 200 800 500 T 1500 350 L 1500 700 Q 1100 900 700 650 T 100 750 Z" />
          <path d="M 200 600 Q 500 400 900 650 T 1400 500" stroke={accent} strokeOpacity="0.4" strokeWidth="2" fill="none" />
        </g>
      );
    case 'atelier':
      // Easel + draped fabric
      return (
        <g fill={fill}>
          <path d="M 650 250 L 950 250 L 950 700 L 650 700 Z" />
          <path d="M 600 700 L 800 200 L 1000 700 Z" stroke={accent} strokeOpacity="0.3" strokeWidth="1.5" fill="none" />
          <path d="M 400 850 Q 600 750 800 820 T 1200 800 L 1200 900 L 400 900 Z" opacity="0.6" />
        </g>
      );
    case 'architectural':
      // Blueprint grid + building outline
      return (
        <g fill="none" stroke={fill} strokeWidth="1.2" strokeOpacity="0.6">
          {Array.from({ length: 20 }).map((_, i) => (
            <line key={`v-${i}`} x1={i * 80} y1="0" x2={i * 80} y2="900" strokeOpacity="0.15" />
          ))}
          {Array.from({ length: 12 }).map((_, i) => (
            <line key={`h-${i}`} x1="0" y1={i * 80} x2="1600" y2={i * 80} strokeOpacity="0.15" />
          ))}
          <rect x="500" y="300" width="600" height="500" stroke={accent} strokeOpacity="0.5" strokeWidth="2" />
          <rect x="550" y="350" width="120" height="160" />
          <rect x="730" y="350" width="120" height="160" />
          <rect x="910" y="350" width="120" height="160" />
          <rect x="550" y="540" width="120" height="160" />
          <rect x="730" y="540" width="120" height="160" />
          <rect x="910" y="540" width="120" height="160" />
        </g>
      );
    case 'industrial':
      // Concentric gear silhouettes
      return (
        <g fill={fill}>
          <circle cx="500" cy="500" r="220" />
          <circle cx="500" cy="500" r="120" fill={accent} fillOpacity="0.2" />
          <circle cx="1100" cy="450" r="160" />
          <circle cx="1100" cy="450" r="80" fill={accent} fillOpacity="0.2" />
          {Array.from({ length: 12 }).map((_, i) => {
            const angle = (i / 12) * Math.PI * 2;
            const x1 = 500 + Math.cos(angle) * 230;
            const y1 = 500 + Math.sin(angle) * 230;
            const x2 = 500 + Math.cos(angle) * 280;
            const y2 = 500 + Math.sin(angle) * 280;
            return <rect key={i} x={x1 - 20} y={y1 - 10} width="50" height="20" transform={`rotate(${(angle * 180) / Math.PI} ${x1} ${y1})`} />;
          })}
        </g>
      );
  }
}

// ─── Colour helpers ───────────────────────────────────────────────────────

const NAMED_PALETTE: Record<string, string> = {
  'aged cream': '#e8dfc8',
  'deep umber': '#3a2418',
  'acid pink': '#ff4fc3',
  'soft sky blue': '#9bc4e2',
  'dark olive': '#3a3a1f',
  'gold leaf': '#c9a227',
  'blackened green': '#10221a',
  'electric lime': '#b4ff38',
  'warm canvas': '#e8dfc8',
  sepia: '#7a4f2a',
  cyan: '#37c7ff',
  'bone white': '#f0e8d8',
  'deep crimson': '#7a1f1f',
  ivory: '#f0e8d8',
  'oxidised brass': '#8a6f3a',
  'soft rose': '#d8a8b0',
  'twilight purple': '#3a2a4f',
  brass: '#8a6f3a',
  'steel blue': '#4f6a8a',
  'ember orange': '#e87e2a',
  vellum: '#f0e8d8',
  'india ink': '#0a0a14',
  amber: '#c9a227',
  bone: '#f0e8d8',
  'midnight teal': '#1a3a47',
  copper: '#8a4f2a',
  sky: '#9bc4e2',
  graphite: '#3a3a3a',
  parchment: '#e8dfc8',
  rust: '#8a3a1f',
  ink: '#0a0a14',
  stone: '#9a948a',
  ecru: '#d8cfba',
  bark: '#3a2a20',
};

function paletteHex(token: string | undefined, fallback: string): string {
  if (!token) return fallback;
  if (token.startsWith('#')) return token;
  const key = token.toLowerCase().trim();
  return NAMED_PALETTE[key] ?? fallback;
}

function withAlpha(hex: string, alpha: number): string {
  const clean = hex.replace('#', '');
  const h = clean.length === 3 ? clean.split('').map((c) => c + c).join('') : clean;
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
