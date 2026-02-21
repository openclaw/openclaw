export function Navbar() {
  return (
    <nav className="fixed top-0 z-50 w-full border-b border-neutral-800/50 bg-neutral-950/80 backdrop-blur-xl">
      <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-6">
        <a href="#" className="flex items-center gap-3">
          <HexagonIcon />
          <span className="text-lg font-bold tracking-tight">THE HIVE</span>
        </a>
        <div className="hidden items-center gap-8 md:flex">
          <a
            href="#architecture"
            className="text-sm text-neutral-400 transition-colors hover:text-amber-400"
          >
            Architecture
          </a>
          <a
            href="#security"
            className="text-sm text-neutral-400 transition-colors hover:text-amber-400"
          >
            Security
          </a>
          <a
            href="#roadmap"
            className="text-sm text-neutral-400 transition-colors hover:text-amber-400"
          >
            Roadmap
          </a>
          <a
            href="https://github.com"
            target="_blank"
            rel="noopener noreferrer"
            className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-2 text-sm font-medium text-amber-400 transition-all hover:border-amber-500/60 hover:bg-amber-500/20"
          >
            View on GitHub
          </a>
        </div>
      </div>
    </nav>
  );
}

function HexagonIcon() {
  return (
    <svg
      width="32"
      height="32"
      viewBox="0 0 32 32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
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
