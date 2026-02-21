export function Footer() {
  return (
    <footer className="border-t border-neutral-800/50 py-12">
      <div className="mx-auto max-w-7xl px-6">
        <div className="flex flex-col items-center justify-between gap-6 sm:flex-row">
          <div className="flex items-center gap-3">
            <HexagonIcon />
            <div>
              <div className="text-sm font-bold">THE HIVE</div>
              <div className="text-xs text-neutral-500">
                queen-claw &middot; MIT License &middot; February 2026
              </div>
            </div>
          </div>
          <div className="flex items-center gap-6">
            <a
              href="#architecture"
              className="text-sm text-neutral-500 transition-colors hover:text-neutral-300"
            >
              Architecture
            </a>
            <a
              href="#security"
              className="text-sm text-neutral-500 transition-colors hover:text-neutral-300"
            >
              Security
            </a>
            <a
              href="#roadmap"
              className="text-sm text-neutral-500 transition-colors hover:text-neutral-300"
            >
              Roadmap
            </a>
          </div>
        </div>
        <div className="mt-8 border-t border-neutral-800/50 pt-8 text-center text-xs text-neutral-600">
          Privacy-Preserving Queen-Centric Swarm Infrastructure for Sovereign AI Agents
        </div>
      </div>
    </footer>
  );
}

function HexagonIcon() {
  return (
    <svg
      width="24"
      height="24"
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
      <circle cx="16" cy="17" r="3" fill="#fbbf24" />
    </svg>
  );
}
