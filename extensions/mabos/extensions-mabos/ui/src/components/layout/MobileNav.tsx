import { Link, useRouterState } from "@tanstack/react-router";
import { Palette, Plus } from "lucide-react";
import { useBusinessContext } from "@/contexts/BusinessContext";
import { navSections } from "@/lib/navigation";

export function MobileNav({ compact }: { compact?: boolean }) {
  const { activeBusiness, isLoading: businessesLoading } = useBusinessContext();
  const routerState = useRouterState();
  const currentPath = routerState.location.pathname;

  const basepath = "/mabos/dashboard";
  const relativePath = currentPath.startsWith(basepath)
    ? currentPath.slice(basepath.length) || "/"
    : currentPath;

  const allItems = navSections.flatMap((section) => section.items);

  return (
    <nav className="flex items-center gap-2 overflow-x-auto px-4 py-2 border-b border-[var(--border-mabos)] bg-[var(--bg-secondary)] scrollbar-hide [-webkit-overflow-scrolling:touch]">
      {/* Compact Business Switcher */}
      <div className="flex items-center gap-1 shrink-0 pr-2 mr-1 border-r border-[var(--border-mabos)]">
        <div className="flex items-center gap-1.5 px-2 py-1.5 rounded-full bg-[var(--bg-tertiary)] text-xs text-[var(--text-primary)]">
          <Palette className="w-3 h-3 text-[var(--accent-purple)]" />
          {!compact && (
            <span>{businessesLoading ? "Loading..." : activeBusiness?.name || "No business"}</span>
          )}
        </div>
        <Link
          to="/onboarding"
          className="flex items-center justify-center w-7 h-7 rounded-full text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors"
          aria-label="New Business"
        >
          <Plus className="w-3.5 h-3.5" />
        </Link>
      </div>

      {allItems.map((item) => {
        const isActive =
          item.path === "/" ? relativePath === "/" : relativePath.startsWith(item.path);

        return (
          <Link
            key={item.path}
            to={item.path}
            className={`flex items-center gap-2 px-3 py-1.5 rounded-full whitespace-nowrap shrink-0 text-sm transition-colors ${
              isActive
                ? "bg-[color-mix(in_srgb,var(--accent-green)_15%,transparent)] text-[var(--accent-green)] font-medium"
                : "text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
            }`}
          >
            <item.icon className="w-4 h-4" />
            {!compact && <span>{item.label}</span>}
          </Link>
        );
      })}
    </nav>
  );
}
