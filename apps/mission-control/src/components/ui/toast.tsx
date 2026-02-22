"use client";

import { useState, useCallback, useEffect, useRef, createContext, useContext } from "react";
import { X, CheckCircle2, AlertCircle, Info, AlertTriangle } from "lucide-react";

// ============================================================================
// Toast System — replaces alert() across the settings page
// ============================================================================

export type ToastType = "success" | "error" | "info" | "warning";

export interface Toast {
    id: string;
    type: ToastType;
    message: string;
    duration?: number;
}

interface ToastContextType {
    addToast: (type: ToastType, message: string, duration?: number) => void;
    removeToast: (id: string) => void;
}

const ToastContext = createContext<ToastContextType | null>(null);

export function useToast() {
    const ctx = useContext(ToastContext);
    if (!ctx) {
        // Fallback if no provider — degrade gracefully
        return {
            addToast: (_type: ToastType, message: string) => {
                console.log(`[Toast] ${message}`);
            },
            removeToast: () => { },
        };
    }
    return ctx;
}

const TOAST_ICONS: Record<ToastType, React.ReactNode> = {
    success: <CheckCircle2 className="w-4 h-4" />,
    error: <AlertCircle className="w-4 h-4" />,
    info: <Info className="w-4 h-4" />,
    warning: <AlertTriangle className="w-4 h-4" />,
};

const TOAST_STYLES: Record<ToastType, string> = {
    success: "bg-emerald-500/10 border-emerald-500/30 text-emerald-300",
    error: "bg-red-500/10 border-red-500/30 text-red-300",
    info: "bg-blue-500/10 border-blue-500/30 text-blue-300",
    warning: "bg-amber-500/10 border-amber-500/30 text-amber-300",
};

function ToastItem({ toast, onDismiss }: { toast: Toast; onDismiss: () => void }) {
    const [exiting, setExiting] = useState(false);
    const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    useEffect(() => {
        const dur = toast.duration ?? 4000;
        if (dur > 0) {
            timerRef.current = setTimeout(() => {
                setExiting(true);
                setTimeout(onDismiss, 300);
            }, dur);
        }
        return () => {
            if (timerRef.current) {clearTimeout(timerRef.current);}
        };
    }, [toast.duration, onDismiss]);

    return (
        <div
            className={`flex items-start gap-3 px-4 py-3 rounded-lg border backdrop-blur-md shadow-lg transition-all duration-300 ${TOAST_STYLES[toast.type]
                } ${exiting ? "opacity-0 translate-x-4" : "opacity-100 translate-x-0"}`}
        >
            <span className="mt-0.5 shrink-0">{TOAST_ICONS[toast.type]}</span>
            <p className="text-sm flex-1">{toast.message}</p>
            <button
                onClick={() => {
                    setExiting(true);
                    setTimeout(onDismiss, 300);
                }}
                className="p-0.5 rounded hover:bg-white/10 transition-colors shrink-0"
            >
                <X className="w-3.5 h-3.5" />
            </button>
        </div>
    );
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
    const [toasts, setToasts] = useState<Toast[]>([]);

    const addToast = useCallback((type: ToastType, message: string, duration?: number) => {
        const id = `toast-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        setToasts((prev) => [...prev, { id, type, message, duration }]);
    }, []);

    const removeToast = useCallback((id: string) => {
        setToasts((prev) => prev.filter((t) => t.id !== id));
    }, []);

    return (
        <ToastContext.Provider value={{ addToast, removeToast }}>
            {children}
            {/* Toast container — fixed to bottom-right */}
            {toasts.length > 0 && (
                <div className="fixed bottom-6 right-6 z-[9999] flex flex-col gap-2 max-w-sm">
                    {toasts.map((toast) => (
                        <ToastItem key={toast.id} toast={toast} onDismiss={() => removeToast(toast.id)} />
                    ))}
                </div>
            )}
        </ToastContext.Provider>
    );
}
