"use client";

export function IntegrationsPanel() {
  return (
    <div className="mx-auto max-w-5xl p-6">
      <div className="mb-6">
        <h1
          className="font-instrument text-3xl tracking-tight"
          style={{ color: "var(--color-text)" }}
        >
          Integrations
        </h1>
        <p
          className="mt-1 text-sm"
          style={{ color: "var(--color-text-muted)" }}
        >
          Manage Dench-managed integrations and search ownership in one place.
        </p>
      </div>

      <div
        className="rounded-2xl border p-6"
        style={{
          background: "var(--color-surface)",
          borderColor: "var(--color-border)",
        }}
      >
        <p
          className="text-sm"
          style={{ color: "var(--color-text-muted)" }}
        >
          Integrations controls will appear here.
        </p>
      </div>
    </div>
  );
}
