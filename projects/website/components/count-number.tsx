"use client"

import { useEffect, useState, useRef } from "react"


function useInView<T extends Element>(opts?: IntersectionObserverInit) {
  const ref = useRef<T | null>(null);
  const [inView, setInView] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const io = new IntersectionObserver(
      ([entry]) => setInView(entry.isIntersecting), 
      { threshold: 0.3, ...opts }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [opts]);

  return { ref, inView } as const;
}

export function CountUp({
  start = 0,
  end,
  duration = 1500,
  prefix = "",
  suffix = "",
  className = "",
  formatter = (n: number) => n.toLocaleString(),
  resetOnExit = true, 
}: {
  start?: number;
  end: number;
  duration?: number;
  prefix?: string;
  suffix?: string;
  className?: string;
  formatter?: (n: number) => string;
  resetOnExit?: boolean;
}) {
  const { ref, inView } = useInView<HTMLSpanElement>();
  const [val, setVal] = useState(start);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    const reduce =
      typeof window !== "undefined" &&
      window.matchMedia &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    if (!inView) {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      if (resetOnExit) setVal(start);
      return;
    }

    if (reduce) {
      setVal(end);
      return;
    }

    const t0 = performance.now();
    const delta = end - start;

    const tick = (t: number) => {
      const p = Math.min(1, (t - t0) / duration);
      const eased = 1 - Math.pow(1 - p, 3); 
      setVal(start + delta * eased);
      if (p < 1) rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [inView, start, end, duration, resetOnExit]);

  return (
    <span ref={ref} className={className}>
      {prefix}
      {formatter(Math.round(val))}
      {suffix}
    </span>
  );
}