/** @jsxImportSource @solidjs/web */

import type { JSX } from "@solidjs/web";
import type { ControlUiSettingsContextV2 } from "openclaw/plugin-sdk/control-ui";
import { content, hostControl } from "./host-control.tsx";
import { useSettings } from "./i18n.ts";
export function SettingsSection(props: {
  title?: JSX.Element;
  description?: JSX.Element;
  actions?: JSX.Element;
  danger?: boolean;
  children?: JSX.Element;
}) {
  const host = useSettings().components;
  const title = content(() => props.title);
  const description = content(() => props.description);
  const actions = content(() => props.actions);
  const children = content(() => props.children);
  return hostControl(
    () => ({
      title,
      danger: props.danger,
      description: props.description === undefined ? undefined : description,
      actions: props.actions === undefined ? undefined : actions,
      content: children,
    }),
    host.mountSection,
  );
}
export function SettingsRow(props: {
  title: JSX.Element;
  description?: JSX.Element;
  control?: JSX.Element;
}) {
  const host = useSettings().components;
  const title = content(() => props.title);
  const description = content(() => props.description);
  const control = content(() => props.control);
  return hostControl(
    () => ({
      title,
      description: props.description === undefined ? undefined : description,
      control: props.control === undefined ? undefined : control,
    }),
    host.mountRow,
  );
}
export function SettingsDetailsRow(props: {
  title: JSX.Element;
  description?: JSX.Element;
  control?: JSX.Element;
  detailsLabel: string;
  hasDetails?: boolean;
  children?: JSX.Element;
}) {
  const host = useSettings().components;
  const title = content(() => props.title);
  const description = content(() => props.description);
  const control = content(() => props.control);
  const children = content(() => props.children);
  return hostControl(
    () => ({
      title,
      description: props.description === undefined ? undefined : description,
      control: props.control === undefined ? undefined : control,
      detailsLabel: props.detailsLabel,
      hasDetails: props.hasDetails,
      content: children,
    }),
    host.mountDetailsRow,
  );
}
export function SettingsDisclosure(props: {
  title: JSX.Element;
  quiet?: boolean;
  children?: JSX.Element;
}) {
  const host = useSettings().components;
  const title = content(() => props.title);
  const children = content(() => props.children);
  return hostControl(
    () => ({ title, quiet: props.quiet, content: children }),
    host.mountDisclosure,
  );
}
export function SettingsSectionHelp(props: { id: string; section: string; children: JSX.Element }) {
  const host = useSettings().components;
  const children = content(() => props.children);
  return hostControl(
    () => ({ id: props.id, section: props.section, content: children }),
    host.mountSectionHelp,
  );
}
export function SettingsStatus(props: {
  kind: "ok" | "warn" | "danger" | "accent" | "muted";
  label: string;
}) {
  const host = useSettings().components;
  return hostControl(() => ({ kind: props.kind, label: props.label }), host.mountStatus);
}
export function SettingsValue(props: { value: string | number; mono?: boolean }) {
  const host = useSettings().components;
  return hostControl(() => ({ value: props.value, mono: props.mono }), host.mountValue);
}
export function SettingsSecretInput(
  props: Parameters<ControlUiSettingsContextV2["components"]["mountSecretInput"]>[1],
) {
  const host = useSettings().components;
  return hostControl(() => ({ ...props }), host.mountSecretInput);
}
export function Icon(props: { name: "copy" }) {
  const host = useSettings().components;
  return hostControl(() => ({ name: props.name }), host.mountIcon);
}
