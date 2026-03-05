"use client";

import { ConvexProvider, ConvexReactClient } from "convex/react";
import { AnimatePresence } from "framer-motion";
import { useMemo } from "react";

export function Providers({ children }: { children: React.ReactNode }) {
  const convex = useMemo(() => {
    const url = process.env.NEXT_PUBLIC_CONVEX_URL;
    if (!url) return null;
    return new ConvexReactClient(url);
  }, []);

  const content = <AnimatePresence mode="wait">{children}</AnimatePresence>;

  if (!convex) return content;

  return <ConvexProvider client={convex}>{content}</ConvexProvider>;
}
