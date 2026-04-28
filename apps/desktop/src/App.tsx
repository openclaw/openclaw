import { startTransition, useEffect, useState } from "react";
import { getGatewaySnapshot, listenForGatewayStatus, restartGateway } from "./api";
import type { GatewaySnapshot } from "./types";

function redactTokenFragment(url: string): string {
  const hashIdx = url.indexOf("#");
  if (hashIdx === -1) return url;
  const base = url.slice(0, hashIdx);
  const fragment = url.slice(hashIdx + 1);
  if (!fragment) return url;
  const params = fragment.split("&");
  const hasToken = params.some((p) => p.startsWith("token="));
  if (!hasToken) return url;
  const masked = params
    .map((p) => (p.startsWith("token=") ? "token=***" : p))
    .join("&");
  return `${base}#${masked}`;
}

function statusClasses(connected: boolean): string {
  return connected
    ? "bg-emerald-500/15 text-emerald-200 ring-emerald-400/25"
    : "bg-rose-500/15 text-rose-200 ring-rose-400/25";
}

export default function App() {
  const [snapshot, setSnapshot] = useState<GatewaySnapshot | null>(null);
  const [frameKey, setFrameKey] = useState(0);
  const [isRestarting, setIsRestarting] = useState(false);

  useEffect(() => {
    let active = true;
    let cleanup: (() => void) | undefined;

    void getGatewaySnapshot().then((next) => {
      if (!active) {
        return;
      }
      startTransition(() => {
        setSnapshot(next);
      });
    });

    void listenForGatewayStatus((next) => {
      if (!active) {
        return;
      }
      startTransition(() => {
        setSnapshot(next);
      });
    }).then((unlisten) => {
      if (!active) {
        unlisten();
      } else {
        cleanup = unlisten;
      }
    });

    return () => {
      active = false;
      cleanup?.();
    };
  }, []);

  const connected = snapshot?.connected ?? false;
  const dashboardUrl = snapshot?.dashboardUrl ?? "about:blank";
  const displayDashboardUrl = redactTokenFragment(dashboardUrl);
  const endpoint = snapshot?.wsUrl ?? "ws://127.0.0.1:18789";
  const configPath = snapshot?.configPath ?? "~/.openclaw/openclaw.json";
  const error = snapshot?.error ?? "Polling gateway health...";
  const tokenBadge = snapshot?.tokenDetected ? "Token detected" : "No token detected";

  async function handleRestart() {
    setIsRestarting(true);
    try {
      const next = await restartGateway();
      startTransition(() => {
        setSnapshot(next);
      });
      setFrameKey((value) => value + 1);
    } finally {
      setIsRestarting(false);
    }
  }

  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top,_rgba(184,73,43,0.18),_transparent_38%),linear-gradient(180deg,_#11222b_0%,_#0b1220_40%,_#060b13_100%)] text-white">
      <div className="mx-auto flex min-h-screen max-w-[1800px] flex-col gap-6 px-5 py-5 lg:px-8">
        <section className="rounded-[28px] border border-white/10 bg-white/6 p-5 shadow-dashboard backdrop-blur-xl">
          <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
            <div className="space-y-3">
              <div className="inline-flex items-center gap-2 rounded-full bg-white/8 px-3 py-1 text-xs uppercase tracking-[0.24em] text-white/70">
                <span className="h-2 w-2 rounded-full bg-[#ff8d5a]" />
                OpenClaw Desktop MVP
              </div>
              <div>
                <h1 className="text-3xl font-semibold tracking-tight text-white lg:text-4xl">
                  Desktop Companion
                </h1>
                <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-200/80 lg:text-base">
                  The window below embeds the existing Gateway Control UI. Closing this window
                  hides the app to the system tray instead of quitting it.
                </p>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <span
                className={`inline-flex items-center gap-2 rounded-full px-3 py-2 text-sm font-medium ring-1 ${statusClasses(connected)}`}
              >
                <span
                  className={`h-2.5 w-2.5 rounded-full ${connected ? "bg-emerald-300" : "bg-rose-300"}`}
                />
                {snapshot?.statusLabel ?? "Checking gateway..."}
              </span>
              <button
                className="rounded-full border border-white/15 bg-white/10 px-4 py-2 text-sm font-medium text-white transition hover:bg-white/16 disabled:cursor-not-allowed disabled:opacity-60"
                onClick={() => setFrameKey((value) => value + 1)}
                type="button"
              >
                Reload Dashboard
              </button>
              <button
                className="rounded-full bg-[#ff8d5a] px-4 py-2 text-sm font-semibold text-slate-950 transition hover:bg-[#ff9c72] disabled:cursor-not-allowed disabled:bg-[#d97954]"
                disabled={isRestarting}
                onClick={() => {
                  void handleRestart();
                }}
                type="button"
              >
                {isRestarting ? "Restarting..." : "Restart Gateway"}
              </button>
            </div>
          </div>

          <div className="mt-5 grid gap-3 text-sm text-slate-200/75 lg:grid-cols-3">
            <div className="rounded-2xl border border-white/10 bg-black/15 px-4 py-3">
              <div className="text-[11px] uppercase tracking-[0.24em] text-slate-300/60">
                Gateway Endpoint
              </div>
              <div className="mt-1 break-all font-medium text-white">{endpoint}</div>
            </div>
            <div className="rounded-2xl border border-white/10 bg-black/15 px-4 py-3">
              <div className="text-[11px] uppercase tracking-[0.24em] text-slate-300/60">
                Config Source
              </div>
              <div className="mt-1 break-all font-medium text-white">{configPath}</div>
            </div>
            <div className="rounded-2xl border border-white/10 bg-black/15 px-4 py-3">
              <div className="text-[11px] uppercase tracking-[0.24em] text-slate-300/60">
                Dashboard Auth
              </div>
              <div className="mt-1 font-medium text-white">{tokenBadge}</div>
            </div>
          </div>
        </section>

        <section className="relative flex-1 overflow-hidden rounded-[32px] border border-white/10 bg-[#fffaf1] shadow-dashboard">
          <div className="absolute inset-x-0 top-0 z-10 flex items-center justify-between border-b border-slate-200 bg-white/90 px-5 py-3 text-sm text-slate-700 backdrop-blur">
            <span className="font-medium">Embedded Control UI</span>
            <span className="truncate text-xs text-slate-500">{displayDashboardUrl}</span>
          </div>

          <iframe
            className="mt-[57px] h-[calc(100vh-18rem)] min-h-[620px] w-full bg-white"
            key={`${frameKey}:${dashboardUrl}`}
            referrerPolicy="no-referrer"
            src={dashboardUrl}
            title="OpenClaw Dashboard"
          />

          {!connected ? (
            <div className="pointer-events-none absolute inset-0 mt-[57px] flex items-center justify-center bg-slate-950/44 p-6 backdrop-blur-[2px]">
              <div className="pointer-events-auto max-w-lg rounded-[28px] border border-white/10 bg-slate-950/90 p-6 text-white shadow-2xl">
                <p className="text-xs uppercase tracking-[0.24em] text-rose-200/70">
                  Gateway Offline
                </p>
                <h2 className="mt-2 text-2xl font-semibold">The tray will keep polling.</h2>
                <p className="mt-3 text-sm leading-6 text-slate-200/80">{error}</p>
                <div className="mt-5 flex flex-wrap items-center gap-3">
                  <button
                    className="rounded-full bg-[#ff8d5a] px-4 py-2 text-sm font-semibold text-slate-950 transition hover:bg-[#ff9c72] disabled:cursor-not-allowed disabled:bg-[#d97954]"
                    disabled={isRestarting}
                    onClick={() => {
                      void handleRestart();
                    }}
                    type="button"
                  >
                    {isRestarting ? "Restarting..." : "Restart Gateway"}
                  </button>
                  <button
                    className="rounded-full border border-white/15 px-4 py-2 text-sm font-medium text-white transition hover:bg-white/10"
                    onClick={() => setFrameKey((value) => value + 1)}
                    type="button"
                  >
                    Retry Embed
                  </button>
                </div>
              </div>
            </div>
          ) : null}
        </section>
      </div>
    </main>
  );
}
