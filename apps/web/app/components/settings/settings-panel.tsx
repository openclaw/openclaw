"use client";

import { useState } from "react";
import { SkillStorePanel } from "../skill-store/skill-store-panel";
import { IntegrationsPanel } from "../integrations/integrations-panel";
import { CloudSettingsPanel } from "./cloud-settings-panel";

type SettingsTab = "skills" | "integrations" | "cloud";

const TABS: { id: SettingsTab; label: string }[] = [
  { id: "skills", label: "Skills" },
  { id: "integrations", label: "Integrations" },
  { id: "cloud", label: "Cloud" },
];

export function SettingsPanel({ initialTab }: { initialTab?: string }) {
  const [activeTab, setActiveTab] = useState<SettingsTab>(() => {
    if (initialTab === "skills" || initialTab === "integrations" || initialTab === "cloud") {
      return initialTab;
    }
    return "skills";
  });

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-5xl p-6">
        <div className="mb-6">
          <h1
            className="font-instrument text-3xl tracking-tight"
            style={{ color: "var(--color-text)" }}
          >
            Settings
          </h1>
          <p
            className="mt-1 text-sm"
            style={{ color: "var(--color-text-muted)" }}
          >
            Manage skills, integrations, and cloud configuration.
          </p>
        </div>

        <div
          className="flex w-fit items-center gap-1 mb-6 rounded-xl p-1"
          style={{ background: "var(--color-surface-hover)" }}
        >
          {TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveTab(tab.id)}
              className="px-4 py-1.5 rounded-lg text-sm font-medium transition-all cursor-pointer"
              style={{
                background: activeTab === tab.id ? "var(--color-surface)" : "transparent",
                color: activeTab === tab.id ? "var(--color-text)" : "var(--color-text-muted)",
                boxShadow: activeTab === tab.id ? "var(--shadow-sm)" : "none",
              }}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {activeTab === "skills" && <SkillStorePanel embedded />}
        {activeTab === "integrations" && <IntegrationsPanel embedded />}
        {activeTab === "cloud" && <CloudSettingsPanel />}
      </div>
    </div>
  );
}
