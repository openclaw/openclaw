'use client';

import { useEffect, useState } from 'react';

/** True when viewport is narrower than the given breakpoint (default 768px). SSR-safe. */
export function useIsMobile(breakpoint = 768) {
  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${breakpoint - 1}px)`);
    const handler = () => setIsMobile(mq.matches);
    handler();
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, [breakpoint]);
  return isMobile;
}

/** True on coarse-pointer / no-hover devices (touch). */
export function useIsTouch() {
  const [isTouch, setIsTouch] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia('(hover: none) and (pointer: coarse)');
    const handler = () => setIsTouch(mq.matches);
    handler();
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);
  return isTouch;
}

/** True when user requests reduced motion. */
export function useReducedMotion() {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const handler = () => setReduced(mq.matches);
    handler();
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);
  return reduced;
}
