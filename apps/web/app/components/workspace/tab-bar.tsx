"use client";

import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import { type Tab, HOME_TAB_ID } from "@/lib/tab-state";
import dynamic from "next/dynamic";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
} from "../ui/dropdown-menu";

const Tabs = dynamic(
  () => import("@sinm/react-chrome-tabs").then((mod) => mod.Tabs),
  { ssr: false },
);

import { appServeUrl } from "./app-viewer";

type TabBarProps = {
  tabs: Tab[];
  activeTabId: string | null;
  onActivate: (tabId: string) => void;
  onClose: (tabId: string) => void;
  onCloseOthers: (tabId: string) => void;
  onCloseToRight: (tabId: string) => void;
  onCloseAll: () => void;
  onReorder: (fromIndex: number, toIndex: number) => void;
  onTogglePin: (tabId: string) => void;
  liveChatTabIds?: Set<string>;
  onStopTab?: (tabId: string) => void;
  onNewTab?: () => void;
  leftContent?: React.ReactNode;
  rightContent?: React.ReactNode;
};

type ContextMenuState = {
  tabId: string;
  x: number;
  y: number;
} | null;

function tabToFaviconClass(tab: Tab, isLive: boolean): string | undefined {
  switch (tab.type) {
    case "home": return "dench-favicon-home";
    case "chat": return isLive ? "dench-favicon-chat-live" : "dench-favicon-chat";
    case "app": return "dench-favicon-app";
    case "cron": return "dench-favicon-cron";
    case "object": return "dench-favicon-object";
    default: return "dench-favicon-file";
  }
}

function tabToFavicon(tab: Tab): string | boolean | undefined {
  if (tab.icon && tab.path && /\.(png|svg|jpe?g|webp)$/i.test(tab.icon)) {
    return appServeUrl(tab.path, tab.icon);
  }
  return false;
}

export function TabBar({
  tabs,
  activeTabId,
  onActivate,
  onClose,
  onCloseOthers,
  onCloseToRight,
  onCloseAll,
  onReorder,
  onTogglePin,
  liveChatTabIds,
  onStopTab,
  onNewTab,
  leftContent,
  rightContent,
}: TabBarProps) {
  const [contextMenu, setContextMenu] = useState<ContextMenuState>(null);
  const [isDark, setIsDark] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const rightClickTimeRef = useRef(0);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    setIsDark(document.documentElement.classList.contains("dark") || mq.matches);
    const handler = () => setIsDark(document.documentElement.classList.contains("dark") || mq.matches);
    mq.addEventListener("change", handler);
    const obs = new MutationObserver(handler);
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => { mq.removeEventListener("change", handler); obs.disconnect(); };
  }, []);

  useEffect(() => {
    const blockRightClick = (e: PointerEvent | MouseEvent) => {
      if (e.button === 2) {
        const tab = (e.target as Element).closest?.(".chrome-tab");
        if (tab && wrapperRef.current?.contains(tab)) {
          e.stopImmediatePropagation();
          e.preventDefault();
          rightClickTimeRef.current = Date.now();
        }
      }
    };
    document.addEventListener("pointerdown", blockRightClick, true);
    document.addEventListener("mousedown", blockRightClick, true);
    return () => {
      document.removeEventListener("pointerdown", blockRightClick, true);
      document.removeEventListener("mousedown", blockRightClick, true);
    };
  }, []);

  const handleContextMenu = useCallback((tabId: string, event: MouseEvent) => {
    if (!tabId || tabId === HOME_TAB_ID) return;
    event.preventDefault();
    event.stopPropagation();
    const tabEl = (event.target as Element).closest?.(".chrome-tab");
    if (tabEl) tabEl.setAttribute("data-context", "true");
    setContextMenu({ tabId, x: event.clientX, y: event.clientY });
  }, []);

  const homeTab = tabs.find((t) => t.id === HOME_TAB_ID);
  const nonHomeTabs = useMemo(() => tabs.filter((t) => t.id !== HOME_TAB_ID), [tabs]);

  const chromeTabs = useMemo(() => {
    return nonHomeTabs.map((tab) => ({
      id: tab.id,
      title: tab.title,
      active: tab.id === activeTabId,
      favicon: tabToFavicon(tab),
      faviconClass: tabToFaviconClass(tab, liveChatTabIds?.has(tab.id) ?? false),
      isCloseIconVisible: !tab.pinned,
    }));
  }, [nonHomeTabs, activeTabId, liveChatTabIds]);

  const handleActive = useCallback((id: string) => {
    if (Date.now() - rightClickTimeRef.current < 200) return;
    onActivate(id);
  }, [onActivate]);
  const handleClose = useCallback((id: string) => onClose(id), [onClose]);
  const handleReorder = useCallback(
    (tabId: string, _fromIndex: number, toIndex: number) => {
      const fromIndex = tabs.findIndex((t) => t.id === tabId);
      if (fromIndex >= 0 && fromIndex !== toIndex) onReorder(fromIndex, toIndex);
    },
    [tabs, onReorder],
  );

  if (tabs.length === 0) return null;

  const contextTab = contextMenu ? tabs.find((t) => t.id === contextMenu.tabId) : null;

  return (
    <>
      <div ref={wrapperRef} className="dench-chrome-tabs-wrapper flex items-center shrink-0 relative">
        {leftContent && (
          <div className="flex items-center px-1.5 shrink-0 z-10">
            {leftContent}
          </div>
        )}
        <div className="flex-1 min-w-0">
          <Tabs
            darkMode={isDark}
            tabs={chromeTabs}
            draggable
            onTabActive={handleActive}
            onTabClose={handleClose}
            onTabReorder={handleReorder}
            onContextMenu={handleContextMenu}
            pinnedRight={onNewTab ? (
              <button
                type="button"
                onClick={onNewTab}
                className="flex items-center justify-center w-7 h-7 rounded-full shrink-0 cursor-pointer transition-colors hover:bg-black/5 dark:hover:bg-white/5 ml-2"
                style={{ color: "var(--color-text-muted)" }}
                title="New chat"
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 5v14" /><path d="M5 12h14" />
                </svg>
              </button>
            ) : undefined}
          />
        </div>
        {rightContent && (
          <div className="flex items-center gap-0.5 px-2 shrink-0 z-10">
            {rightContent}
          </div>
        )}
      </div>

      {contextMenu && contextTab && (
        <DropdownMenu open onOpenChange={(open) => {
          if (!open) {
            wrapperRef.current?.querySelector("[data-context]")?.removeAttribute("data-context");
            setContextMenu(null);
          }
        }}>
          <DropdownMenuTrigger
            className="fixed w-0 h-0 opacity-0"
            style={{ left: contextMenu.x, top: contextMenu.y }}
          />
          <DropdownMenuContent align="start" side="bottom" className="min-w-[180px]">
            <DropdownMenuItem onSelect={() => { onTogglePin(contextMenu.tabId); setContextMenu(null); }}>
              {contextTab.pinned ? "Unpin Tab" : "Pin Tab"}
            </DropdownMenuItem>
            {contextTab.type === "chat" && liveChatTabIds?.has(contextMenu.tabId) && onStopTab && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => { onStopTab(contextMenu.tabId); setContextMenu(null); }}>
                  Stop Session
                </DropdownMenuItem>
              </>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem
              disabled={contextTab.pinned}
              onSelect={() => { onClose(contextMenu.tabId); setContextMenu(null); }}
            >
              Close
              <DropdownMenuShortcut>⌘W</DropdownMenuShortcut>
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => { onCloseOthers(contextMenu.tabId); setContextMenu(null); }}>
              Close Others
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => { onCloseToRight(contextMenu.tabId); setContextMenu(null); }}>
              Close to the Right
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => { onCloseAll(); setContextMenu(null); }}>
              Close All
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </>
  );
}
