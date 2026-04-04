"use client";

import { useEffect, useRef, useState, ReactNode } from "react";

export default function RevealItem({
  index,
  className = "",
  delayStep = 120,
  children,
}: {
  index: number;
  className?: string;
  delayStep?: number;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          setShown(true);
          io.unobserve(el);
        });
      },
      { root: null, rootMargin: "-35% 0px -35% 0px", threshold: 0.25 }
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    <div
      ref={ref}
      className={[
        "h-full overflow-hidden",
        shown ? "opacity-100 translate-y-0 blur-0" : "opacity-0 translate-y-6",
        "transition-all duration-700 will-change-transform will-change-opacity",
        className,
      ].join(" ")}
      style={{ transitionDelay: `${index * delayStep}ms` }}
    >
      {children}
    </div>
  );
}
