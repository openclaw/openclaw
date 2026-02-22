"use client";

/**
 * Skip-to-content link for keyboard accessibility (WCAG 2.4.1).
 * Visually hidden until focused, then appears at top of page.
 */
export function SkipToContent() {
    return (
        <a
            href="#main-content"
            className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-[100] focus:px-4 focus:py-2 focus:rounded-md focus:bg-primary focus:text-primary-foreground focus:text-sm focus:font-medium focus:shadow-lg focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 transition-all"
        >
            Skip to main content
        </a>
    );
}
