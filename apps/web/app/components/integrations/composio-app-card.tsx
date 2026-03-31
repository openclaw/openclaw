"use client";

import type { ComposioToolkit, ComposioConnection } from "@/lib/composio";

export function ComposioAppCard({
  toolkit,
  connection,
  onClick,
}: {
  toolkit: ComposioToolkit;
  connection: ComposioConnection | null;
  onClick: () => void;
}) {
  const connected = connection?.status === "ACTIVE";

  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-colors hover:bg-[var(--color-surface-hover)]"
    >
      <div
        className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-lg"
        style={{ background: "var(--color-surface-hover)" }}
      >
        {toolkit.logo ? (
          <img
            src={toolkit.logo}
            alt=""
            className="h-5 w-5 object-contain"
            loading="lazy"
          />
        ) : (
          <span
            className="text-xs font-semibold uppercase"
            style={{ color: "var(--color-text-muted)" }}
          >
            {toolkit.name.slice(0, 2)}
          </span>
        )}
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium text-foreground">
            {toolkit.name}
          </span>
          {connected && (
            <span className="inline-flex shrink-0 items-center rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-medium text-emerald-400">
              Connected
            </span>
          )}
        </div>
        {toolkit.description && (
          <p className="mt-0.5 truncate text-[11px] leading-4 text-muted-foreground">
            {toolkit.description}
          </p>
        )}
      </div>
    </button>
  );
}
