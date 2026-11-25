import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

export const LEGACY_SIGNAL_TRANSPORT_FIELDS = [
  "configPath",
  "httpUrl",
  "httpHost",
  "httpPort",
  "cliPath",
  "autoStart",
  "startupTimeoutMs",
  "receiveMode",
  "ignoreStories",
] as const;

export function hasLegacySignalTransportFields(value: unknown): boolean {
  return (
    isRecord(value) && LEGACY_SIGNAL_TRANSPORT_FIELDS.some((field) => Object.hasOwn(value, field))
  );
}
