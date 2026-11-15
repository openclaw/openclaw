export type FreeBsdServiceDiscovery =
  | {
      schema: 1;
      service: "openclaw";
      status: "absent" | "present";
      context: { cwd: string; env: { HOME: string; PATH: string; LC_ALL: string } };
      directories: string[];
      definitions: { path: string; executable: boolean }[];
      selected: string | null;
    }
  | { schema: 1; service: "openclaw"; status: "unknown"; reason: string };

export function discoverFreeBsdService(options: {
  timeoutMs?: number;
  /** Register synchronous cleanup without changing the caller's exit policy. */
  registerExitCleanup: (cleanup: () => void) => () => void;
}): Promise<FreeBsdServiceDiscovery>;
