"use client";

import { useState, useCallback, useEffect, useMemo } from "react";
import { type Tab, HOME_TAB_ID } from "@/lib/tab-state";
import dynamic from "next/dynamic";

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
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    window.addEventListener("click", close);
    window.addEventListener("contextmenu", close);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("contextmenu", close);
    };
  }, [contextMenu]);

  const handleContextMenu = useCallback((tabId: string, event: MouseEvent) => {
    if (!tabId || tabId === HOME_TAB_ID) return;
    event.preventDefault();
    event.stopPropagation();
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

  const handleActive = useCallback((id: string) => onActivate(id), [onActivate]);
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
      <div className="dench-chrome-tabs-wrapper flex items-center shrink-0 relative">
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
              <div className="flex items-center gap-1.5 ml-1.5">
                {nonHomeTabs.length > 0 && nonHomeTabs[nonHomeTabs.length - 1].id !== activeTabId && (
                  <div className="w-px h-4 shrink-0" style={{ background: "var(--color-border)" }} />
                )}
                <button
                  type="button"
                  onClick={onNewTab}
                  className="flex items-center justify-center w-7 h-7 rounded-full shrink-0 cursor-pointer transition-colors hover:bg-black/5 dark:hover:bg-white/5"
                  style={{ color: "var(--color-text-muted)" }}
                  title="New chat"
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 5v14" /><path d="M5 12h14" />
                  </svg>
                </button>
              </div>
            ) : undefined}
          />
        </div>
        {rightContent && (
          <div className="flex items-center gap-0.5 px-2 shrink-0 z-10">
            {rightContent}
          </div>
        )}
      </div>

      {/* Context menu */}
      {contextMenu && contextTab && (
        <div
          className="fixed z-9999 min-w-[180px] rounded-2xl p-1 bg-neutral-100/67 dark:bg-neutral-900/67 border border-white dark:border-white/10 backdrop-blur-md shadow-[0_0_25px_0_rgba(0,0,0,0.16)]"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          <ContextMenuItem
            label={contextTab.pinned ? "Unpin Tab" : "Pin Tab"}
            onClick={() => { onTogglePin(contextMenu.tabId); setContextMenu(null); }}
          />
          {contextTab.type === "chat" && liveChatTabIds?.has(contextMenu.tabId) && onStopTab && (
            <>
              <div className="h-px my-0.5 mx-1 bg-neutral-400/15" />
              <ContextMenuItem
                label="Stop Session"
                onClick={() => { onStopTab(contextMenu.tabId); setContextMenu(null); }}
              />
            </>
          )}
          <div className="h-px my-0.5 mx-1 bg-neutral-400/15" />
          <ContextMenuItem
            label="Close"
            shortcut="⌘W"
            disabled={contextTab.pinned}
            onClick={() => { onClose(contextMenu.tabId); setContextMenu(null); }}
          />
          <ContextMenuItem
            label="Close Others"
            onClick={() => { onCloseOthers(contextMenu.tabId); setContextMenu(null); }}
          />
          <ContextMenuItem
            label="Close to the Right"
            onClick={() => { onCloseToRight(contextMenu.tabId); setContextMenu(null); }}
          />
          <ContextMenuItem
            label="Close All"
            onClick={() => { onCloseAll(); setContextMenu(null); }}
          />
        </div>
      )}
    </>
  );
}

function ContextMenuItem({
  label,
  shortcut,
  disabled,
  onClick,
}: {
  label: string;
  shortcut?: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="w-full flex items-center justify-between px-2.5 py-1.5 text-[12.5px] text-left rounded-xl transition-all disabled:opacity-40 hover:bg-neutral-400/15"
      style={{ color: "var(--color-text)" }}
    >
      <span>{label}</span>
      {shortcut && (
        <span className="ml-4 text-[11px]" style={{ color: "var(--color-text-muted)" }}>
          {shortcut}
        </span>
      )}
    </button>
  );
}
