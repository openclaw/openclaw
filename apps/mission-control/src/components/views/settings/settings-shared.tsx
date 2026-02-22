"use client";

import { useState } from "react";
import { ChevronRight, Check } from "lucide-react";
import type { ThemeMode } from "./settings-types";

// ============================================================================
// SettingsSection — collapsible card wrapper
// ============================================================================

interface SectionProps {
    icon: React.ReactNode;
    title: string;
    description?: string;
    children: React.ReactNode;
    defaultOpen?: boolean;
    id?: string;
}

export function SettingsSection({ icon, title, description, children, defaultOpen = true, id }: SectionProps) {
    const [isOpen, setIsOpen] = useState(defaultOpen);

    return (
        <div id={id} className="bg-card border border-border rounded-xl overflow-hidden transition-all duration-200 hover:border-border/80">
            <button
                onClick={() => setIsOpen(!isOpen)}
                className="w-full flex items-center justify-between p-5 hover:bg-muted/30 transition-colors"
            >
                <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center text-primary">
                        {icon}
                    </div>
                    <div className="text-left">
                        <h3 className="font-semibold">{title}</h3>
                        {description && (
                            <p className="text-sm text-muted-foreground">{description}</p>
                        )}
                    </div>
                </div>
                <ChevronRight
                    className={`w-5 h-5 text-muted-foreground transition-transform duration-200 ${isOpen ? "rotate-90" : ""}`}
                />
            </button>
            <div
                className={`transition-all duration-200 ease-in-out overflow-hidden ${isOpen ? "max-h-[5000px] opacity-100" : "max-h-0 opacity-0"
                    }`}
            >
                <div className="px-5 pb-5 pt-2 border-t border-border/50">{children}</div>
            </div>
        </div>
    );
}

// ============================================================================
// Toggle — switch with label and description
// ============================================================================

interface ToggleProps {
    enabled: boolean;
    onChange: (enabled: boolean) => void;
    label: string;
    description?: string;
    icon?: React.ReactNode;
}

export function Toggle({ enabled, onChange, label, description, icon }: ToggleProps) {
    return (
        <div className="flex items-center justify-between py-3">
            <div className="flex items-center gap-3">
                {icon && <span className="text-muted-foreground">{icon}</span>}
                <div>
                    <p className="text-sm font-medium">{label}</p>
                    {description && (
                        <p className="text-xs text-muted-foreground">{description}</p>
                    )}
                </div>
            </div>
            <button
                onClick={() => onChange(!enabled)}
                type="button"
                role="switch"
                aria-checked={enabled}
                aria-label={label}
                className={`relative w-11 h-6 rounded-full transition-colors duration-200 ${enabled ? "bg-primary" : "bg-muted"
                    }`}
            >
                <span
                    className={`absolute top-1 w-4 h-4 rounded-full bg-white shadow transition-transform duration-200 ${enabled ? "left-6" : "left-1"
                        }`}
                />
            </button>
        </div>
    );
}

// ============================================================================
// ThemeButton — theme picker card
// ============================================================================

interface ThemeButtonProps {
    mode: ThemeMode;
    currentMode: ThemeMode;
    icon: React.ReactNode;
    label: string;
    onClick: () => void;
}

export function ThemeButton({ mode, currentMode, icon, label, onClick }: ThemeButtonProps) {
    const isActive = mode === currentMode;
    return (
        <button
            onClick={onClick}
            className={`flex-1 flex flex-col items-center gap-2 p-4 rounded-xl border transition-all duration-200 ${isActive
                    ? "border-primary bg-primary/10 shadow-[0_0_15px_oklch(0.58_0.2_260/0.2)]"
                    : "border-border hover:border-primary/50 hover:bg-muted/30"
                }`}
        >
            <div
                className={`w-12 h-12 rounded-full flex items-center justify-center transition-colors duration-200 ${isActive ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"
                    }`}
            >
                {icon}
            </div>
            <span className={`text-sm font-medium ${isActive ? "text-primary" : ""}`}>
                {label}
            </span>
            {isActive && <Check className="w-4 h-4 text-primary" />}
        </button>
    );
}

// ============================================================================
// ApiKeyStatusBadge — status indicator for API keys
// ============================================================================

export function ApiKeyStatusBadge({ status, isActive }: { status: string | null; isActive: boolean }) {
    if (!isActive) {
        return (
            <span className="px-2 py-0.5 rounded text-xs font-medium bg-gray-500/10 text-gray-400 border border-gray-500/30">
                Inactive
            </span>
        );
    }
    if (status === "success" || status === "active") {
        return (
            <span className="px-2 py-0.5 rounded text-xs font-medium bg-emerald-500/10 text-emerald-400 border border-emerald-500/30">
                Active
            </span>
        );
    }
    if (status === "failed" || status === "error") {
        return (
            <span className="px-2 py-0.5 rounded text-xs font-medium bg-red-500/10 text-red-400 border border-red-500/30">
                Test Failed
            </span>
        );
    }
    return (
        <span className="px-2 py-0.5 rounded text-xs font-medium bg-amber-500/10 text-amber-400 border border-amber-500/30">
            Untested
        </span>
    );
}

// ============================================================================
// Skeleton — loading placeholder
// ============================================================================

export function SettingsSkeleton({ lines = 3 }: { lines?: number }) {
    return (
        <div className="space-y-3 animate-pulse">
            {Array.from({ length: lines }).map((_, i) => (
                <div key={i} className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-lg bg-muted" />
                    <div className="flex-1 space-y-2">
                        <div className="h-4 w-1/3 rounded bg-muted" />
                        <div className="h-3 w-2/3 rounded bg-muted" />
                    </div>
                </div>
            ))}
        </div>
    );
}
