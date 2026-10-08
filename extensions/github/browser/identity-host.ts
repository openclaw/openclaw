import type { TemplateResult, nothing } from "lit";
import type { GitHubPresentationHost } from "./presentation-host.js";

/** Generic settings primitives keep the plugin aligned with its host's design system. */
export type GitHubIdentityHost = Pick<GitHubPresentationHost, "t"> & {
  icons: { copy: unknown };
  handleCopyButton: (event: Event, text: string, idleLabel: string) => Promise<boolean>;
  externalLinkTarget: string;
  buildExternalLinkRel: () => string;
  formatUiExternalText: (value: string) => string;
  formatDateTimeMs: (milliseconds: number, options?: Intl.DateTimeFormatOptions) => string;
  renderSettingsRow: (props: {
    title: unknown;
    description?: unknown;
    control?: TemplateResult | typeof nothing;
  }) => TemplateResult;
  renderSettingsSection: (
    props: {
      title?: unknown;
      description?: unknown;
      actions?: TemplateResult;
      danger?: boolean;
    },
    rows: unknown,
  ) => TemplateResult;
  renderSettingsStatus: (props: {
    kind: "ok" | "warn" | "danger" | "accent" | "muted";
    label: unknown;
  }) => TemplateResult;
  renderSettingsValue: (value: unknown) => TemplateResult;
  renderSettingsSecretInput: (props: {
    ariaLabel: string;
    value: string;
    visible: boolean;
    disabled?: boolean;
    showLabel: string;
    hideLabel: string;
    toggleLabel: string;
    onInput: (value: string) => void;
    onToggle: () => void;
  }) => TemplateResult;
  renderSettingsSegmented: <T extends string>(props: {
    value: T;
    options: ReadonlyArray<{ value: T; label: unknown }>;
    disabled?: boolean;
    ariaLabel?: string;
    onChange: (value: T) => void;
  }) => TemplateResult;
};
