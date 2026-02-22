import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from "react";
import type { SidebarMode, EntityType, DetailPanelState } from "@/lib/types";

type PanelState = {
  sidebarMode: SidebarMode;
  toggleSidebar: () => void;
  setSidebarMode: (mode: SidebarMode) => void;
  detailPanel: DetailPanelState;
  openDetailPanel: (type: EntityType, id: string, data: unknown) => void;
  closeDetailPanel: () => void;
};

const PanelContext = createContext<PanelState | null>(null);

const defaultDetailPanel: DetailPanelState = {
  open: false,
  entityType: null,
  entityId: null,
  entityData: null,
};

export function PanelProvider({ children }: { children: ReactNode }) {
  const [sidebarMode, setSidebarMode] = useState<SidebarMode>("collapsed");
  const [detailPanel, setDetailPanel] = useState<DetailPanelState>(defaultDetailPanel);

  const toggleSidebar = useCallback(
    () => setSidebarMode((m) => (m === "collapsed" ? "expanded" : "collapsed")),
    [],
  );

  const openDetailPanel = useCallback((type: EntityType, id: string, data: unknown) => {
    setDetailPanel({ open: true, entityType: type, entityId: id, entityData: data });
  }, []);

  const closeDetailPanel = useCallback(() => {
    setDetailPanel(defaultDetailPanel);
  }, []);

  // Keyboard shortcuts
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const target = e.target as HTMLElement;
      if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable) {
        if (e.key !== "Escape") return;
      }

      if (e.key === "b" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        toggleSidebar();
      } else if (e.key === "Escape") {
        if (detailPanel.open) {
          closeDetailPanel();
        }
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [detailPanel.open, toggleSidebar, closeDetailPanel]);

  return (
    <PanelContext.Provider
      value={{
        sidebarMode,
        toggleSidebar,
        setSidebarMode,
        detailPanel,
        openDetailPanel,
        closeDetailPanel,
      }}
    >
      {children}
    </PanelContext.Provider>
  );
}

export function usePanels() {
  const ctx = useContext(PanelContext);
  if (!ctx) throw new Error("usePanels must be used within a PanelProvider");
  return ctx;
}
