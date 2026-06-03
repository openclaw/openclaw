'use client';

import { useLenisSmoothScroll } from '@/lib/use-lenis';

export function SmoothScrollProvider({ children }: { children: React.ReactNode }) {
  useLenisSmoothScroll();
  return <>{children}</>;
}
