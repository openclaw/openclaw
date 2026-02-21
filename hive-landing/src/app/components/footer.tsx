const FOOTER_ASCII = `  ⬡ ⬡ ⬡     THE HIVE     ⬡ ⬡ ⬡`;

export function Footer() {
  return (
    <footer className="border-t border-neutral-800/50 py-12">
      <div className="mx-auto max-w-7xl px-6">
        <div className="flex flex-col items-center justify-between gap-6 sm:flex-row">
          <div className="flex items-center gap-3">
            <HexagonIcon />
            <div>
              <div className="font-mono text-sm font-bold tracking-wider">
                THE::HIVE
              </div>
              <div className="font-mono text-[10px] text-neutral-500">
                queen-claw // MIT License // 2026
              </div>
            </div>
          </div>
          <div className="flex items-center gap-6">
            <FooterLink href="#architecture">Architecture</FooterLink>
            <FooterLink href="#security">Security</FooterLink>
            <FooterLink href="#roadmap">Roadmap</FooterLink>
          </div>
        </div>

        <div className="mt-8 border-t border-neutral-800/50 pt-8 text-center">
          <pre className="font-mono text-[10px] text-neutral-700">{FOOTER_ASCII}</pre>
          <p className="mt-3 text-xs text-neutral-600">
            Privacy-Preserving Queen-Centric Swarm Infrastructure for Sovereign AI Agents
          </p>
        </div>
      </div>
    </footer>
  );
}

function FooterLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a
      href={href}
      className="font-mono text-xs text-neutral-500 transition-colors hover:text-amber-400"
    >
      {children}
    </a>
  );
}

function HexagonIcon() {
  return (
    <svg
      width="24"
      height="24"
      viewBox="0 0 32 32"
      fill="none"
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
