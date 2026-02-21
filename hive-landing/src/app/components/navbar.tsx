"use client";

import { useEffect, useState } from "react";

export function Navbar() {
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 20);
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <nav
      className={`fixed top-0 z-50 w-full transition-all duration-300 ${
        scrolled
          ? "border-b border-neutral-800/80 bg-neutral-950/90 shadow-lg shadow-black/20 backdrop-blur-xl"
          : "border-b border-transparent bg-transparent"
      }`}
    >
      <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-6">
        <a href="#" className="group flex items-center gap-3">
          <div className="relative">
            <HexagonIcon />
            <div className="absolute inset-0 rounded-full bg-amber-500/20 opacity-0 blur-md transition-opacity group-hover:opacity-100" />
          </div>
          <span className="font-mono text-sm font-bold tracking-widest text-neutral-300 transition-colors group-hover:text-amber-400">
            THE::HIVE
          </span>
        </a>
        <div className="hidden items-center gap-8 md:flex">
          <NavLink href="#architecture">Architecture</NavLink>
          <NavLink href="#security">Security</NavLink>
          <NavLink href="#roadmap">Roadmap</NavLink>
          <a
            href="https://github.com"
            target="_blank"
            rel="noopener noreferrer"
            className="group relative rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-2 text-sm font-medium text-amber-400 transition-all hover:border-amber-500/60 hover:bg-amber-500/20 hover:shadow-lg hover:shadow-amber-500/10"
          >
            <span className="relative z-10">View on GitHub</span>
          </a>
        </div>
      </div>
    </nav>
  );
}

function NavLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a
      href={href}
      className="group relative text-sm text-neutral-400 transition-colors hover:text-amber-400"
    >
      {children}
      <span className="absolute -bottom-1 left-0 h-px w-0 bg-amber-500 transition-all group-hover:w-full" />
    </a>
  );
}

function HexagonIcon() {
  return (
    <svg
      width="32"
      height="32"
      viewBox="0 0 32 32"
      fill="none"
      className="transition-transform duration-300 group-hover:rotate-[30deg]"
    >
      <path
        d="M16 2L28.66 9V23L16 30L3.34 23V9L16 2Z"
        stroke="#f59e0b"
        strokeWidth="2"
        fill="none"
      />
      <path
        d="M16 8L23.46 12.5V21.5L16 26L8.54 21.5V12.5L16 8Z"
        stroke="#fbbf24"
        strokeWidth="1.5"
        fill="#f59e0b"
        fillOpacity="0.15"
      />
      <circle cx="16" cy="17" r="3" fill="#fbbf24" />
    </svg>
  );
}
