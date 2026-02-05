// Section components
export { ProfileSection } from "./ProfileSection";
export { PreferencesSection } from "./PreferencesSection";
export { AIProviderSection } from "./AIProviderSection";
export { ModelProviderSection } from "./ModelProviderSection";
export { GatewaySection } from "./GatewaySection";
export { GuidancePacksSection } from "./GuidancePacksSection";
export { ChannelsSection } from "./ChannelsSection";
export { AgentsSection } from "./AgentsSection";
export { ToolsetsSection } from "./ToolsetsSection";
export { ToolsetEditor } from "./ToolsetEditor";
export { AdvancedSection } from "./AdvancedSection";
export { ConnectionsSection } from "./ConnectionsSection";
export { ConnectionsSectionWithOAuth } from "./ConnectionsSectionWithOAuth";
export { ConnectionWizardWithScopes } from "./ConnectionWizardWithScopes";
export { ScopeSelector } from "./ScopeSelector";
export { ScopeCheckbox } from "./ScopeCheckbox";
export { ScopeGroup } from "./ScopeGroup";
export { ConnectionScopesStep, useScopeSelection } from "./ConnectionScopesStep";
export { UsageSection } from "./UsageSection";
export { HealthSection } from "./HealthSection";
export { KeyboardShortcutsModal } from "./KeyboardShortcutsModal";

// New "You" page sections
export { ComingSoonSection } from "./ComingSoonSection";
export { InteractionStyleSection } from "./InteractionStyleSection";
export { AppearanceSection } from "./AppearanceSection";
export { AccessibilitySection } from "./AccessibilitySection";
export { NotificationsSection } from "./NotificationsSection";
export { AvailabilitySection } from "./AvailabilitySection";
export { PrivacyDataSection } from "./PrivacyDataSection";
export { ActivitySessionsSection } from "./ActivitySessionsSection";

// Legacy navigation (includes all sections - may be removed later)
export { SettingsNav, type SettingsSection } from "./SettingsNav";
export { SettingsMobileNav } from "./SettingsMobileNav";

// Profile navigation (personalization only - for /you route)
export { ProfileNav, type ProfileSection as ProfileSectionType } from "./ProfileNav";
export { ProfileMobileNav } from "./ProfileMobileNav";

// Config navigation (system config only - for /settings route)
export { SettingsConfigNav, type ConfigSection } from "./SettingsConfigNav";
export { SettingsConfigMobileNav } from "./SettingsConfigMobileNav";
