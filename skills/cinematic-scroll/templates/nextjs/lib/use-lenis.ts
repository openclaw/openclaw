'use client';

import { useEffect } from 'react';
import Lenis from 'lenis';

/**
 * Smooth scroll for release pages. Disabled when prefers-reduced-motion is set.
 * If GSAP ScrollTrigger is used, forward Lenis rAF to ScrollTrigger.update().
 */
export function useLenisSmoothScroll(enabled = true) {
  useEffect(() => {
    if (!enabled) return;
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    if (mq.matches) return;

    const lenis = new Lenis({
      duration: 1.2,
      smoothWheel: true,
      wheelMultiplier: 1,
      touchMultiplier: 1.2,
    });

    let frameId = 0;
    const raf = (time: number) => {
      lenis.raf(time);
      frameId = requestAnimationFrame(raf);
    };
    frameId = requestAnimationFrame(raf);

    return () => {
      cancelAnimationFrame(frameId);
      lenis.destroy();
    };
  }, [enabled]);
}
