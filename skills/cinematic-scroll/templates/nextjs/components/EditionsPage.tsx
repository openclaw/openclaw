'use client';

import React from 'react';
import { ScrollBackgroundMorph } from 'choreo-3d';
import { editionChapters, editionThemes } from '@/lib/editions-manifest';
import { ChapterScene } from '@/components/ChapterScene';

/**
 * Editions release page orchestrator.
 *
 * Each chapter is a self-contained <ChapterScene> with 7 parallax layers,
 * a perspective camera, word-stagger title reveal, and a mobile fallback.
 * This file stays small on purpose — extend chapters in `editions-manifest.ts`.
 */
export function EditionsPage() {
  const [activeId, setActiveId] = React.useState(editionChapters[0]?.id ?? null);

  React.useEffect(() => {
    const nodes = editionChapters
      .map((chapter) => document.getElementById(chapter.id))
      .filter(Boolean) as HTMLElement[];

    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
        if (visible?.target.id) setActiveId(visible.target.id);
      },
      { threshold: [0.25, 0.5, 0.75], rootMargin: '-10% 0px -10% 0px' },
    );

    nodes.forEach((node) => observer.observe(node));
    return () => observer.disconnect();
  }, []);

  return (
    <main className="relative min-h-screen overflow-x-hidden bg-[#0b0907] text-white selection:bg-white selection:text-black">
      <ScrollBackgroundMorph activeId={activeId} themes={editionThemes} />
      <TopNav />
      <ChapterIndex activeId={activeId} />

      {editionChapters.map((chapter, i) => (
        <ChapterScene key={chapter.id} chapter={chapter} eager={i === 0} />
      ))}
    </main>
  );
}

// ─── Persistent top nav with safe-area + 44px tap targets ─────────────────

function TopNav() {
  return (
    <nav
      className="fixed inset-x-0 top-0 z-50 flex items-center justify-between bg-black/30 px-[max(env(safe-area-inset-left),1.25rem)] backdrop-blur-sm md:px-8"
      style={{ paddingTop: 'max(env(safe-area-inset-top), 0.75rem)', paddingBottom: '0.75rem' }}
    >
      <a
        href="#prologue"
        className="grid h-11 min-w-[44px] place-items-center font-mono text-xs uppercase tracking-[0.22em] text-white"
      >
        Editions Demo
      </a>
      <div className="hidden items-center gap-2 md:flex">
        {editionChapters.slice(1, 5).map((chapter) => (
          <a
            key={chapter.id}
            href={`#${chapter.id}`}
            className="grid h-11 min-w-[44px] place-items-center px-3 text-xs uppercase tracking-[0.18em] text-white/75 hover:text-white"
          >
            {chapter.eyebrow}
          </a>
        ))}
        <a
          href="#prologue"
          className="ml-2 grid h-11 min-w-[88px] place-items-center rounded-full bg-white px-5 text-xs font-semibold uppercase tracking-[0.16em] text-black"
        >
          Start
        </a>
      </div>
    </nav>
  );
}

// ─── Persistent chapter index — hidden on mobile, hidden on iPad portrait ─

function ChapterIndex({ activeId }: { activeId: string | null }) {
  return (
    <aside
      aria-label="Chapter index"
      className="fixed bottom-6 left-5 z-50 hidden w-44 text-white/70 lg:block"
      style={{
        paddingLeft: 'env(safe-area-inset-left)',
        paddingBottom: 'env(safe-area-inset-bottom)',
      }}
    >
      <p className="mb-3 font-mono text-[10px] uppercase tracking-[0.24em]">Chapters</p>
      <div className="space-y-1">
        {editionChapters.map((chapter) => {
          const isActive = activeId === chapter.id;
          return (
            <a
              key={chapter.id}
              href={`#${chapter.id}`}
              className="grid min-h-[36px] grid-cols-[24px_1fr] items-baseline gap-2 font-mono text-[11px] uppercase tracking-[0.16em]"
              aria-current={isActive ? 'true' : undefined}
            >
              <span className={isActive ? 'text-white' : 'text-white/35'}>{chapter.roman}</span>
              <span className={isActive ? 'text-white' : 'text-white/45'}>{chapter.eyebrow}</span>
            </a>
          );
        })}
      </div>
    </aside>
  );
}
