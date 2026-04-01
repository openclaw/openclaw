import { useRouterState } from "@tanstack/react-router";
import { useEffect, type ReactNode } from "react";
import { usePanels } from "@/contexts/PanelContext";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { FloatingChat } from "../chat/FloatingChat";
import { EntityDetailPanel } from "./EntityDetailPanel";
import { MobileNav } from "./MobileNav";
import { Sidebar } from "./Sidebar";

/** Auto-close detail panel on route change */
function RouteChangeHandler() {
  const { closeDetailPanel } = usePanels();
  const currentPath = useRouterState({ select: (s) => s.location.pathname });
  useEffect(() => {
    closeDetailPanel();
  }, [currentPath, closeDetailPanel]);
  return null;
}

export function AppShell({ children }: { children: ReactNode }) {
  const { sidebarMode } = usePanels();
  const isMobile = useMediaQuery("(max-width: 768px)");
  const isPhone = useMediaQuery("(max-width: 320px)");

  if (isMobile) {
    return (
      <div className="flex flex-col h-screen bg-[var(--bg-primary)]">
        <RouteChangeHandler />
        <MobileNav compact={isPhone} />
        <main className="flex-1 overflow-y-auto p-4">{children}</main>
        <EntityDetailPanel />
        <FloatingChat />
      </div>
    );
  }

  return (
    <>
      <RouteChangeHandler />
      <div
        className="grid h-screen overflow-hidden bg-[var(--bg-primary)]"
        style={{
          gridTemplateColumns: `${sidebarMode === "collapsed" ? 64 : 280}px minmax(0, 1fr)`,
          transition: "grid-template-columns 300ms ease-in-out",
        }}
      >
        <Sidebar />
        <main className="overflow-y-auto p-6">{children}</main>
      </div>

      {/* Right detail panel: fixed-position overlay, NOT in grid */}
      <EntityDetailPanel />

      {/* Floating chat: fixed-position, z-index above everything */}
      <FloatingChat />
    </>
  );
}
