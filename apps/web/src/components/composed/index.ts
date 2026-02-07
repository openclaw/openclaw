// Composed utility components
export { DetailPanel } from "./DetailPanel";
export { StatusBadge, type StatusType } from "./StatusBadge";
export { MetricCard } from "./MetricCard";
export { AgentAvatar, type AgentAvatarProps, type AgentAvatarSize, type AgentAvatarStatus } from "./AgentAvatar";
export { ThemeToggle } from "./ThemeToggle";
export { UltraCompactCommandPalette } from "./UltraCompactCommandPalette";
export type { PaletteCommand, CommandCategory } from "./UltraCompactCommandPalette";
export { CommandPalette, type CommandPaletteProps } from "./CommandPalette";
export { KeyboardShortcutsModal, type ShortcutDef, type ShortcutCategory } from "./KeyboardShortcutsModal";
export { ConfirmDialog, type ConfirmDialogProps } from "./ConfirmDialog";
export { TokenCostIndicator, type TokenCostIndicatorProps } from "./TokenCostIndicator";
// WebTerminal is lazy-loaded on demand - import directly from ./WebTerminal when needed
// export { WebTerminal, type WebTerminalProps, type WebTerminalRef } from "./WebTerminal";
export type { WebTerminalProps, WebTerminalRef } from "./WebTerminal";
export { AgentWorkbench, type AgentWorkbenchProps } from "./AgentWorkbench";
export {
  CardSkeleton,
  ListItemSkeleton,
  AvatarSkeleton,
  TextSkeleton,
  MetricCardSkeleton,
  ChatMessageSkeleton,
} from "./LoadingSkeleton";
export { RouteErrorFallback, type RouteErrorFallbackProps } from "./RouteErrorFallback";
export { ErrorState, errorMessages, type ErrorStateProps, type ErrorStateVariant } from "./ErrorState";
