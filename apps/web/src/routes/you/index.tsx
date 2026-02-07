"use client";

import * as React from "react";
import { createFileRoute } from "@tanstack/react-router";

import {
  ProfileSection,
  ProfileNav,
  ProfileMobileNav,
  InteractionStyleSection,
  AppearanceSection,
  AccessibilitySection,
  NotificationsSection,
  AvailabilitySection,
  PrivacyDataSection,
  ActivitySessionsSection,
  type ProfileSectionType,
} from "@/components/domain/settings";
import { useUIStore } from "@/stores/useUIStore";

import { RouteErrorFallback } from "@/components/composed";
const ALL_SECTIONS = new Set<ProfileSectionType>([
  "profile",
  "interaction-style",
  "appearance",
  "notifications",
  "accessibility",
  "availability",
  "privacy",
  "activity",
]);

export const Route = createFileRoute("/you/")({
  component: YouPage,
  errorComponent: RouteErrorFallback,
  validateSearch: (search: Record<string, unknown>): { section?: ProfileSectionType } => {
    const section = search.section as ProfileSectionType | undefined;
    return {
      section: section && ALL_SECTIONS.has(section) ? section : undefined,
    };
  },
});

function YouPage() {
  const navigate = Route.useNavigate();
  const { section: searchSection } = Route.useSearch();
  const powerUserMode = useUIStore((state) => state.powerUserMode);

  const [activeSection, setActiveSection] = React.useState<ProfileSectionType>(
    searchSection || "profile"
  );

  // Sync URL with active section
  const handleSectionChange = React.useCallback(
    (section: ProfileSectionType) => {
      setActiveSection(section);
      navigate({
        search: (prev) => (section === "profile" ? {} : { ...prev, section }),
        replace: true,
      });
    },
    [navigate]
  );

  // Update active section when URL changes
  React.useEffect(() => {
    if (searchSection && searchSection !== activeSection) {
      setActiveSection(searchSection);
    }
  }, [searchSection, activeSection]);

  // If user navigates to activity section without power user mode, redirect to profile
  React.useEffect(() => {
    if (activeSection === "activity" && !powerUserMode) {
      handleSectionChange("profile");
    }
  }, [activeSection, powerUserMode, handleSectionChange]);

  const renderSection = () => {
    switch (activeSection) {
      case "profile":
        return <ProfileSection />;
      case "interaction-style":
        return <InteractionStyleSection />;
      case "appearance":
        return <AppearanceSection />;
      case "notifications":
        return <NotificationsSection />;
      case "accessibility":
        return <AccessibilitySection />;
      case "availability":
        return <AvailabilitySection />;
      case "privacy":
        return <PrivacyDataSection />;
      case "activity":
        return powerUserMode ? <ActivitySessionsSection /> : <ProfileSection />;
      default:
        return <ProfileSection />;
    }
  };

  return (
    <>
      {/* Header */}
      <div className="mb-8">
        <h1 className="text-3xl font-bold">You</h1>
        <p className="text-muted-foreground mt-1">
          Personalize your profile and preferences.
        </p>
      </div>

      {/* Main Content */}
      <div className="flex flex-col lg:flex-row gap-8">
        {/* Sidebar Navigation - Desktop */}
        <aside className="hidden lg:block w-64 shrink-0">
          <div className="sticky top-8">
            <ProfileNav
              activeSection={activeSection}
              onSectionChange={handleSectionChange}
            />
          </div>
        </aside>

        {/* Mobile Navigation */}
        <div className="lg:hidden sticky top-0 z-20 -mx-4 px-4 py-2 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80">
          <ProfileMobileNav
            activeSection={activeSection}
            onSectionChange={handleSectionChange}
          />
        </div>

        {/* Content Area */}
        <main className="flex-1 min-w-0">
          {renderSection()}
        </main>
      </div>
    </>
  );
}
