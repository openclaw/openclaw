"use client";

import * as React from "react";
import { createFileRoute } from "@tanstack/react-router";

import {
  ModelProviderSection,
  GatewaySection,
  ChannelsSection,
  AgentsSection,
  ToolsetsSection,
  HealthSection,
  AdvancedSection,
  ConnectionsSection,
  UsageSection,
  GuidancePacksSection,
  KeyboardShortcutsModal,
} from "@/components/domain/settings";
import { SettingsConfigNav, type ConfigSection } from "@/components/domain/settings/SettingsConfigNav";
import { SettingsConfigMobileNav } from "@/components/domain/settings/SettingsConfigMobileNav";

import { RouteErrorFallback } from "@/components/composed";
export const Route = createFileRoute("/settings/")({
  component: SettingsPage,
  errorComponent: RouteErrorFallback,
  validateSearch: (search: Record<string, unknown>): { section?: ConfigSection; agentId?: string } => {
    const validSections: ConfigSection[] = [
      "health",
      "ai-provider",
      "gateway",
      "channels",
      "agents",
      "guidance",
      "toolsets",
      "advanced",
      "connections",
      "usage",
    ];
    const section = search.section as ConfigSection | undefined;
    const agentId = typeof search.agentId === "string" ? search.agentId : undefined;
    return {
      section: section && validSections.includes(section) ? section : undefined,
      agentId,
    };
  },
});

function SettingsPage() {
  const navigate = Route.useNavigate();
  const { section: searchSection, agentId } = Route.useSearch();

  const [activeSection, setActiveSection] = React.useState<ConfigSection>(
    searchSection || "health"
  );
  const [shortcutsOpen, setShortcutsOpen] = React.useState(false);

  // Sync URL with active section
  const handleSectionChange = (section: ConfigSection) => {
    setActiveSection(section);
    navigate({
      search: (prev) => (section === "health" ? {} : { ...prev, section }),
      replace: true,
    });
  };

  // Update active section when URL changes
  React.useEffect(() => {
    if (searchSection && searchSection !== activeSection) {
      setActiveSection(searchSection);
    }
  }, [searchSection, activeSection]);

  React.useEffect(() => {
    if (searchSection !== "agents" || !agentId) {return;}
    navigate({
      search: (prev) => ({ ...prev, agentId: undefined }),
      replace: true,
    });
  }, [searchSection, agentId, navigate]);

  const renderSection = () => {
    switch (activeSection) {
      case "health":
        return <HealthSection />;
      case "ai-provider":
        return <ModelProviderSection />;
      case "gateway":
        return <GatewaySection />;
      case "channels":
        return <ChannelsSection />;
      case "agents":
        return <AgentsSection initialEditAgentId={agentId} />;
      case "guidance":
        return <GuidancePacksSection />;
      case "toolsets":
        return <ToolsetsSection />;
      case "advanced":
        return <AdvancedSection onOpenShortcuts={() => setShortcutsOpen(true)} />;
      case "connections":
        return <ConnectionsSection />;
      case "usage":
        return <UsageSection />;
      default:
        return <HealthSection />;
    }
  };

  return (
    <>
      {/* Header */}
      <div className="mb-8">
        <h1 className="text-3xl font-bold">Settings</h1>
        <p className="text-muted-foreground mt-1">
          Configure your system, channels, and integrations.
        </p>
      </div>

      {/* Main Content */}
      <div className="flex flex-col lg:flex-row gap-8">
        {/* Sidebar Navigation - Desktop */}
        <aside className="hidden lg:block w-64 shrink-0">
          <div className="sticky top-8">
            <SettingsConfigNav
              activeSection={activeSection}
              onSectionChange={handleSectionChange}
            />
          </div>
        </aside>

        {/* Mobile Navigation */}
        <div className="lg:hidden sticky top-0 z-20 -mx-4 px-4 py-2 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80">
          <SettingsConfigMobileNav
            activeSection={activeSection}
            onSectionChange={handleSectionChange}
          />
        </div>

        {/* Content Area */}
        <main className="flex-1 min-w-0">
          {renderSection()}
        </main>
      </div>

      {/* Keyboard Shortcuts Modal */}
      <KeyboardShortcutsModal open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
    </>
  );
}
