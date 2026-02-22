"use client";

/**
 * Content-shaped loading skeletons for each view type.
 * Replaces the generic Loader2 spinner with layout-aware placeholders
 * that reduce perceived loading time and prevent layout shift.
 */

function Pulse({ className = "", style }: { className?: string; style?: React.CSSProperties }) {
    return (
        <div
            className={`animate-pulse rounded-lg bg-muted/60 ${className}`}
            style={style}
        />
    );
}

function SkeletonCard({ className = "" }: { className?: string }) {
    return (
        <div className={`glass-card p-4 space-y-3 ${className}`}>
            <Pulse className="h-4 w-2/5" />
            <Pulse className="h-3 w-4/5" />
            <Pulse className="h-3 w-3/5" />
        </div>
    );
}

/** Grid of agent/plugin cards */
function GridSkeleton() {
    return (
        <div className="p-6 space-y-6">
            <div className="flex items-center justify-between">
                <Pulse className="h-7 w-48" />
                <Pulse className="h-9 w-28 rounded-md" />
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {Array.from({ length: 6 }).map((_, i) => (
                    <SkeletonCard key={i} />
                ))}
            </div>
        </div>
    );
}

/** List of tasks/missions/employees */
function ListSkeleton() {
    return (
        <div className="p-6 space-y-4">
            <div className="flex items-center justify-between">
                <Pulse className="h-7 w-40" />
                <div className="flex gap-2">
                    <Pulse className="h-9 w-24 rounded-md" />
                    <Pulse className="h-9 w-32 rounded-md" />
                </div>
            </div>
            <div className="space-y-3">
                {Array.from({ length: 8 }).map((_, i) => (
                    <div key={i} className="glass-card p-4 flex items-center gap-4">
                        <Pulse className="h-10 w-10 rounded-full shrink-0" />
                        <div className="flex-1 space-y-2">
                            <Pulse className="h-4 w-3/5" />
                            <Pulse className="h-3 w-2/5" />
                        </div>
                        <Pulse className="h-6 w-16 rounded-full" />
                    </div>
                ))}
            </div>
        </div>
    );
}

/** Stat cards + content areas */
function DashboardSkeleton() {
    return (
        <div className="p-6 space-y-6">
            {/* Stat cards row */}
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                {Array.from({ length: 4 }).map((_, i) => (
                    <div key={i} className="glass-card p-4 space-y-2">
                        <Pulse className="h-3 w-20" />
                        <Pulse className="h-8 w-16" />
                        <Pulse className="h-3 w-24" />
                    </div>
                ))}
            </div>
            {/* Content area */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                <div className="glass-card p-5 space-y-4">
                    <Pulse className="h-5 w-32" />
                    {Array.from({ length: 4 }).map((_, i) => (
                        <div key={i} className="flex items-center gap-3">
                            <Pulse className="h-8 w-8 rounded-md shrink-0" />
                            <div className="flex-1 space-y-1">
                                <Pulse className="h-3 w-3/4" />
                                <Pulse className="h-3 w-1/2" />
                            </div>
                        </div>
                    ))}
                </div>
                <div className="glass-card p-5 space-y-4">
                    <Pulse className="h-5 w-40" />
                    <Pulse className="h-48 w-full rounded-md" />
                </div>
            </div>
        </div>
    );
}

/** Chat message bubbles */
function ChatSkeleton() {
    return (
        <div className="flex flex-col h-full">
            {/* Chat header */}
            <div className="border-b border-border/50 p-4 flex items-center gap-3">
                <Pulse className="h-8 w-8 rounded-full" />
                <Pulse className="h-4 w-32" />
            </div>
            {/* Messages area */}
            <div className="flex-1 p-4 space-y-4">
                {/* Incoming messages (left-aligned) */}
                <div className="flex gap-3 max-w-[70%]">
                    <Pulse className="h-8 w-8 rounded-full shrink-0" />
                    <div className="space-y-2">
                        <Pulse className="h-16 w-64 rounded-xl" />
                        <Pulse className="h-3 w-16" />
                    </div>
                </div>
                {/* Outgoing message (right-aligned) */}
                <div className="flex gap-3 max-w-[70%] ml-auto flex-row-reverse">
                    <Pulse className="h-8 w-8 rounded-full shrink-0" />
                    <div className="space-y-2 flex flex-col items-end">
                        <Pulse className="h-12 w-48 rounded-xl" />
                        <Pulse className="h-3 w-12" />
                    </div>
                </div>
                {/* Another incoming */}
                <div className="flex gap-3 max-w-[70%]">
                    <Pulse className="h-8 w-8 rounded-full shrink-0" />
                    <div className="space-y-2">
                        <Pulse className="h-24 w-72 rounded-xl" />
                        <Pulse className="h-3 w-20" />
                    </div>
                </div>
            </div>
            {/* Input area */}
            <div className="border-t border-border/50 p-4">
                <Pulse className="h-10 w-full rounded-lg" />
            </div>
        </div>
    );
}

/** Settings / form layout */
function FormSkeleton() {
    return (
        <div className="p-6 space-y-6">
            <Pulse className="h-7 w-36" />
            <div className="space-y-6 max-w-2xl">
                {Array.from({ length: 5 }).map((_, i) => (
                    <div key={i} className="space-y-2">
                        <Pulse className="h-4 w-24" />
                        <Pulse className="h-10 w-full rounded-md" />
                    </div>
                ))}
                <Pulse className="h-10 w-32 rounded-md" />
            </div>
        </div>
    );
}

/** Log/terminal output */
function LogSkeleton() {
    // Deterministic widths — Math.random() in render causes flicker on re-render
    const lineWidths = [72, 55, 88, 63, 45, 80, 50, 70, 60, 85, 48, 75];
    return (
        <div className="p-6 space-y-4">
            <div className="flex items-center justify-between">
                <Pulse className="h-7 w-28" />
                <div className="flex gap-2">
                    <Pulse className="h-8 w-20 rounded-md" />
                    <Pulse className="h-8 w-20 rounded-md" />
                </div>
            </div>
            <div className="glass-card p-4 font-mono space-y-2">
                {lineWidths.map((w, i) => (
                    <Pulse
                        key={i}
                        className="h-4"
                        style={{ width: `${w}%` }}
                    />
                ))}
            </div>
        </div>
    );
}

export type SkeletonVariant =
    | "grid"
    | "list"
    | "dashboard"
    | "chat"
    | "form"
    | "log";

const VARIANT_MAP: Record<SkeletonVariant, () => React.ReactNode> = {
    grid: GridSkeleton,
    list: ListSkeleton,
    dashboard: DashboardSkeleton,
    chat: ChatSkeleton,
    form: FormSkeleton,
    log: LogSkeleton,
};

export function ViewSkeleton({
    variant = "list",
}: {
    variant?: SkeletonVariant;
}) {
    const SkeletonComponent = VARIANT_MAP[variant];
    return (
        <div className="flex-1 min-h-0" aria-busy="true" aria-label="Loading view">
            <SkeletonComponent />
        </div>
    );
}
