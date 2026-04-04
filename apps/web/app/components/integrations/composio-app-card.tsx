"use client";

import { useState } from "react";
import type { ComposioToolkit } from "@/lib/composio";

function AppIcon({ logo, name }: { logo: string | null; name: string }) {
  const [failed, setFailed] = useState(false);
  const showImg = logo && !failed;
  return (
    <div
      className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden"
      style={{
        background: "var(--color-surface-hover)",
        borderRadius: "13px",
        boxShadow: "inset 0 0 0 0.5px rgba(0,0,0,0.06), 0 1px 3px rgba(0,0,0,0.06)",
      }}
    >
      {showImg ? (
        <img
          src={logo}
          alt=""
          className="h-7 w-7 object-contain"
          loading="lazy"
          decoding="async"
          onError={() => setFailed(true)}
        />
      ) : (
        <span
          className="text-sm font-semibold uppercase"
          style={{ color: "var(--color-text-muted)" }}
        >
          {name.slice(0, 2)}
        </span>
      )}
    </div>
  );
}

export function ComposioAppCard({
  toolkit,
  activeConnections,
  totalConnections,
  mode = "marketplace",
  onClick,
}: {
  toolkit: ComposioToolkit;
  activeConnections: number;
  totalConnections?: number;
  featured?: boolean;
  mode?: "connected" | "marketplace";
  onClick: () => void;
}) {
  const connected = activeConnections > 0;

  return (
    <div
      className="group rounded-2xl p-3.5 flex items-start gap-3.5 cursor-pointer transition-shadow duration-200 hover:shadow-md"
      style={{
        background: "var(--color-surface)",
        border: "1px solid var(--color-border)",
      }}
      onClick={onClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") onClick(); }}
      aria-label={`${connected ? "Manage" : "Get"} ${toolkit.name}`}
    >
      <AppIcon logo={toolkit.logo} name={toolkit.name} />

      <div className="flex-1 min-w-0 pt-0.5">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div
              className="text-[13px] font-semibold truncate leading-tight"
              style={{ color: "var(--color-text)" }}
            >
              {toolkit.name}
            </div>
            <div className="flex items-center gap-1 mt-0.5 text-[11px]">
              {connected && (
                <>
                  <span
                    className="font-medium"
                    style={{ color: "var(--color-success, #34C759)" }}
                  >
                    {activeConnections} account{activeConnections === 1 ? "" : "s"}
                  </span>
                  {(toolkit.tools_count > 0 || (typeof totalConnections === "number" && totalConnections > activeConnections)) && (
                    <span style={{ color: "var(--color-text-muted)" }}>·</span>
                  )}
                </>
              )}
              {connected && typeof totalConnections === "number" && totalConnections > activeConnections && (
                <>
                  <span style={{ color: "var(--color-text-muted)" }}>
                    {totalConnections} total
                  </span>
                  {toolkit.tools_count > 0 && (
                    <span style={{ color: "var(--color-text-muted)" }}>·</span>
                  )}
                </>
              )}
              {toolkit.tools_count > 0 && (
                <span style={{ color: "var(--color-text-muted)" }}>
                  {toolkit.tools_count} tool{toolkit.tools_count === 1 ? "" : "s"}
                </span>
              )}
            </div>
          </div>

          <span
            className="shrink-0 rounded-full px-3.5 py-1 text-[12px] font-bold mt-0.5"
            style={connected ? {
              background: "var(--color-surface-hover)",
              color: "var(--color-accent)",
            } : {
              background: "var(--color-accent)",
              color: "#fff",
            }}
          >
            {connected ? "Connected" : "Connect"}
          </span>
        </div>

        {toolkit.description && (
          <p
            className="text-[11px] leading-relaxed line-clamp-2 mt-1.5"
            style={{ color: "var(--color-text-muted)" }}
          >
            {toolkit.description}
          </p>
        )}
      </div>
    </div>
  );
}
