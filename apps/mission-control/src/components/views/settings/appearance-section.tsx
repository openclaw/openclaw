"use client";

import { Sun, Moon, Monitor } from "lucide-react";
import { SettingsSection, ThemeButton } from "./settings-shared";
import type { ThemeMode, AppSettings } from "./settings-types";

// ============================================================================
// Appearance Section
// ============================================================================

interface AppearanceSectionProps {
    settings: AppSettings;
    onThemeChange: (theme: ThemeMode) => void;
}

export function AppearanceSection({ settings, onThemeChange }: AppearanceSectionProps) {
    return (
        <SettingsSection
            id="appearance"
            icon={<Sun className="w-5 h-5" />}
            title="Appearance"
            description="Customize how OpenClaw Mission Control looks"
        >
            <div className="flex gap-3">
                <ThemeButton
                    mode="light"
                    currentMode={settings.theme}
                    icon={<Sun className="w-5 h-5" />}
                    label="Light"
                    onClick={() => onThemeChange("light")}
                />
                <ThemeButton
                    mode="dark"
                    currentMode={settings.theme}
                    icon={<Moon className="w-5 h-5" />}
                    label="Dark"
                    onClick={() => onThemeChange("dark")}
                />
                <ThemeButton
                    mode="system"
                    currentMode={settings.theme}
                    icon={<Monitor className="w-5 h-5" />}
                    label="System"
                    onClick={() => onThemeChange("system")}
                />
            </div>
        </SettingsSection>
    );
}
